import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const FIREFOX_DIR = join(homedir(), 'Library', 'Application Support', 'Firefox');

const SAME_SITE = { 1: 'Lax', 2: 'Strict' };

function parseIni(text) {
  const sections = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) sections.push({ name: header[1], values: {} });
    else if (line.includes('=') && sections.length) {
      const i = line.indexOf('=');
      sections.at(-1).values[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  return sections;
}

const resolveProfile = p => (isAbsolute(p) ? p : join(FIREFOX_DIR, p));

export function findProfileDir(explicit) {
  if (explicit) {
    if (!existsSync(join(explicit, 'cookies.sqlite'))) throw new Error(`No cookies.sqlite in ${explicit}`);
    return explicit;
  }

  const candidates = [];
  const ini = join(FIREFOX_DIR, 'profiles.ini');
  if (existsSync(ini)) {
    const sections = parseIni(readFileSync(ini, 'utf8'));
    for (const s of sections.filter(s => s.name.startsWith('Install') && s.values.Default)) {
      candidates.push(resolveProfile(s.values.Default));
    }
    for (const s of sections.filter(s => s.name.startsWith('Profile') && s.values.Default === '1')) {
      candidates.push(s.values.IsRelative === '0' ? s.values.Path : resolveProfile(s.values.Path));
    }
  }
  const profilesDir = join(FIREFOX_DIR, 'Profiles');
  if (existsSync(profilesDir)) {
    for (const d of readdirSync(profilesDir).filter(d => d.endsWith('.default-release'))) {
      candidates.push(join(profilesDir, d));
    }
  }

  const found = candidates.find(dir => existsSync(join(dir, 'cookies.sqlite')));
  if (!found) throw new Error('No Firefox profile with cookies.sqlite found, pass --profile <dir>');
  return found;
}

function snapshotCookieDb(profileDir, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const db = join(cacheDir, 'cookies.sqlite');
  copyFileSync(join(profileDir, 'cookies.sqlite'), db);
  for (const suffix of ['-wal', '-shm']) {
    const src = join(profileDir, `cookies.sqlite${suffix}`);
    const dst = db + suffix;
    if (existsSync(src)) copyFileSync(src, dst);
    else rmSync(dst, { force: true });
  }
  return db;
}

export function readFacebookCookies(profileDir, cacheDir) {
  const db = new DatabaseSync(snapshotCookieDb(profileDir, cacheDir));
  try {
    const rows = db
      .prepare(
        `SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite
           FROM moz_cookies
          WHERE originAttributes = '' AND (host = 'facebook.com' OR host LIKE '%.facebook.com')`,
      )
      .all();

    return rows.map(r => {
      const secure = r.isSecure === 1;
      const expiry = Number(r.expiry);
      return {
        name: r.name,
        value: r.value,
        domain: r.host,
        path: r.path,
        expires: expiry <= 0 ? -1 : Math.floor(expiry > 1e11 ? expiry / 1000 : expiry),
        secure,
        httpOnly: r.isHttpOnly === 1,
        sameSite: SAME_SITE[r.sameSite] ?? (secure ? 'None' : 'Lax'),
      };
    });
  } finally {
    db.close();
  }
}
