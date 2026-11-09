import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BROWSERS = ['Google/Chrome Canary', 'Google/Chrome', 'Chromium'];
const SAME_SITE = { 0: 'None', 1: 'Lax', 2: 'Strict' };

function cookieFiles(explicit) {
  if (explicit) return [explicit.endsWith('Cookies') ? explicit : join(explicit, 'Cookies')];
  const base = join(homedir(), 'Library', 'Application Support');
  return BROWSERS.flatMap(b => ['Default', 'Profile 1', 'Profile 2'].map(p => join(base, b, p, 'Cookies')));
}

let key = null;
function chromeKey() {
  if (key) return key;
  const password = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], {
    encoding: 'utf8',
  }).trim();
  key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  return key;
}

function decrypt(value, host, hashedHost) {
  if (value.subarray(0, 3).toString() !== 'v10') return value.toString();
  const decipher = createDecipheriv('aes-128-cbc', chromeKey(), Buffer.alloc(16, ' '));
  const plain = Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]);
  return (hashedHost ? plain.subarray(32) : plain).toString();
}

export function readChromeCookies(domain, cacheDir, explicit) {
  const file = cookieFiles(explicit).find(f => {
    if (!existsSync(f)) return false;
    const db = new DatabaseSync(f, { readOnly: true });
    try {
      return db.prepare(`SELECT 1 FROM cookies WHERE host_key LIKE ? AND name = 'sessionid'`).get(`%${domain}`);
    } catch {
      return false;
    } finally {
      db.close();
    }
  });
  if (!file) throw new Error(`No ${domain} login found in Chrome Canary, Chrome or Chromium`);

  mkdirSync(cacheDir, { recursive: true });
  const copy = join(cacheDir, 'chrome-cookies.sqlite');
  copyFileSync(file, copy);
  const db = new DatabaseSync(copy);
  try {
    const version = Number(db.prepare(`SELECT value FROM meta WHERE key = 'version'`).get()?.value ?? 0);
    const rows = db
      .prepare(
        `SELECT name, encrypted_value, value, host_key, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, samesite
           FROM cookies WHERE host_key = ? OR host_key LIKE ?`,
      )
      .all(domain, `%.${domain}`);
    return rows.map(r => {
      const expires = Number(r.expires_utc);
      return {
        name: r.name,
        value: r.value || decrypt(Buffer.from(r.encrypted_value), r.host_key, version >= 24),
        domain: r.host_key,
        path: r.path,
        expires: expires > 0 ? Math.floor(expires / 1e6 - 11644473600) : -1,
        secure: r.is_secure === 1,
        httpOnly: r.is_httponly === 1,
        sameSite: SAME_SITE[r.samesite] ?? (r.is_secure === 1 ? 'None' : 'Lax'),
      };
    });
  } finally {
    db.close();
    rmSync(copy, { force: true });
  }
}
