#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collectLinks } from './collect.js';
import { loadCookieFile, writeNetscape } from './cookie-file.js';
import { downloadAll } from './download.js';
import { findProfileDir, readFacebookCookies } from './firefox.js';
import { parseVideoLink, resolvePage } from './page.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: fb-dumper <page-url> [options]

Collects every reel/video link of a Facebook page with your Firefox login,
then downloads them all with yt-dlp.

Options:
  --tabs <list>       Tabs to scan, comma separated: reels,videos (default: reels,videos)
  --out <dir>         Output directory (default: downloads/<page>)
  --cookies <file>    Use a cookie export (cookies.txt or JSON) instead of reading Firefox
  --profile <dir>     Firefox profile directory (default: auto-detect)
  --collect-only      Only write links.txt, do not download
  --skip-collect      Only download the links already in links.txt
  --max-links <n>     Stop collecting after n links (for testing)
  --max-idle <n>      Scroll rounds without new content before giving up (default: 6)
  --headful           Show the browser window while collecting
  -h, --help          Show this help

Anything after "--" is passed to yt-dlp unchanged.`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tabs: { type: 'string', default: 'reels,videos' },
    out: { type: 'string' },
    cookies: { type: 'string' },
    profile: { type: 'string' },
    'collect-only': { type: 'boolean', default: false },
    'skip-collect': { type: 'boolean', default: false },
    'max-links': { type: 'string' },
    'max-idle': { type: 'string', default: '6' },
    headful: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [pageInput, ...ytDlpArgs] = positionals;
if (opts.help || !pageInput) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 1);
}

const tabs = opts.tabs.split(',').map(t => t.trim()).filter(Boolean);
const badTab = tabs.find(t => !['reels', 'videos'].includes(t));
if (badTab) throw new Error(`Unknown tab "${badTab}", use reels and/or videos`);

const { slug, tabUrls } = resolvePage(pageInput, tabs);
const outDir = resolve(opts.out ?? join(ROOT, 'downloads', slug));
const linksFile = join(outDir, 'links.txt');
const cacheDir = join(ROOT, '.cache');
mkdirSync(outDir, { recursive: true });

let cookies, cookieArgs;
if (opts.cookies) {
  cookies = loadCookieFile(resolve(opts.cookies));
  const netscape = join(cacheDir, 'cookies.txt');
  writeNetscape(cookies, netscape);
  cookieArgs = ['--cookies', netscape];
  console.log(`Cookies: ${resolve(opts.cookies)}`);
} else {
  const profileDir = findProfileDir(opts.profile);
  cookies = readFacebookCookies(profileDir, cacheDir);
  cookieArgs = ['--cookies-from-browser', `firefox:${profileDir}`];
  console.log(`Firefox: ${profileDir}`);
}
console.log(`Page:    ${slug}`);
console.log(`Output:  ${outDir}`);

if (!opts['skip-collect']) {
  if (!cookies.some(c => c.name === 'c_user')) {
    throw new Error('No Facebook login in these cookies (c_user cookie missing)');
  }

  const links = await collectLinks({
    tabUrls,
    cookies,
    headful: opts.headful,
    maxIdleRounds: Number(opts['max-idle']),
    maxLinks: opts['max-links'] ? Number(opts['max-links']) : Infinity,
  });

  const merged = new Map();
  const previous = existsSync(linksFile) ? readFileSync(linksFile, 'utf8').split('\n') : [];
  for (const url of [...previous, ...links]) {
    const link = url && parseVideoLink(url);
    if (link && !merged.has(link.id)) merged.set(link.id, link.url);
  }
  writeFileSync(linksFile, [...merged.values()].join('\n') + '\n');
  console.log(`\n${links.length} links found, ${merged.size} in ${linksFile}`);
}

if (!opts['collect-only']) {
  if (!existsSync(linksFile)) throw new Error(`${linksFile} does not exist, run without --skip-collect first`);
  const code = await downloadAll({ linksFile, outDir, cookieArgs, extraArgs: ytDlpArgs });
  process.exit(code ?? 1);
}
