import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const isFacebook = domain => /(^|\.)facebook\.com$/.test(domain.replace(/^\./, ''));

function normalizeSameSite(value, secure) {
  const v = String(value ?? '').toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'lax') return 'Lax';
  if (v === 'none' || v === 'no_restriction') return secure ? 'None' : 'Lax';
  return secure ? 'None' : 'Lax';
}

function parseNetscape(text) {
  const cookies = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    } else if (!line.trim() || line.startsWith('#')) continue;
    const [domain, , path, secure, expiry, name, ...rest] = line.split('\t');
    if (rest.length === 0) continue;
    const isSecure = secure === 'TRUE';
    cookies.push({
      name,
      value: rest.join('\t'),
      domain,
      path,
      expires: Number(expiry) > 0 ? Number(expiry) : -1,
      secure: isSecure,
      httpOnly,
      sameSite: isSecure ? 'None' : 'Lax',
    });
  }
  return cookies;
}

function parseJson(data) {
  const cookies = [];
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const domain = node.domain ?? node.host;
    if (typeof node.name === 'string' && 'value' in node && typeof domain === 'string') {
      const secure = Boolean(node.secure ?? node.isSecure);
      let expires = Number(node.expirationDate ?? node.expires ?? node.expiry ?? -1);
      if (expires > 1e11) expires /= 1000;
      cookies.push({
        name: node.name,
        value: String(node.value),
        domain,
        path: node.path ?? '/',
        expires: expires > 0 ? Math.floor(expires) : -1,
        secure,
        httpOnly: Boolean(node.httpOnly ?? node.isHttpOnly),
        sameSite: normalizeSameSite(node.sameSite, secure),
      });
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(data);
  return cookies;
}

export function loadCookieFile(file) {
  const text = readFileSync(file, 'utf8');
  let cookies;
  try {
    cookies = parseJson(JSON.parse(text));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    cookies = parseNetscape(text);
  }
  const fb = cookies.filter(c => isFacebook(c.domain));
  if (fb.length === 0) throw new Error(`No facebook.com cookies found in ${file}`);
  return fb;
}

export function writeNetscape(cookies, file) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = (c.httpOnly ? '#HttpOnly_' : '') + c.domain;
    const sub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    lines.push([domain, sub, c.path, c.secure ? 'TRUE' : 'FALSE', Math.max(0, c.expires), c.name, c.value].join('\t'));
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
}
