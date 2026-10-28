#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collectLinks } from './collect.js';
import { convertToH264 } from './convert.js';
import { loadCookieFile, writeNetscape } from './cookie-file.js';
import { downloadAll } from './download.js';
import { findProfileDir, readFacebookCookies } from './firefox.js';
import { parseVideoLink, resolvePage } from './page.js';
import { killChildren } from './proc.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: fb-dumper <page-url> [options]

Collects every reel/video link of a Facebook page with your Firefox login,
downloads them all with yt-dlp and converts anything that is not H.264.

Options:
  --dest <dir>        Base directory, each page gets its own folder in it (default: downloads)
  --out <dir>         Exact output directory, overrides --dest
  --tabs <list>       Tabs to scan, comma separated: reels,videos (default: reels,videos)
  --cookies <file>    Use a cookie export (cookies.txt or JSON) instead of reading Firefox
  --profile <dir>     Firefox profile directory (default: auto-detect)
  --collect-only      Only write links.txt, do not download
  --skip-collect      Only download the links already in links.txt
  --keep-codec        Do not convert AV1/VP9 files to H.264
  --max-links <n>     Stop collecting after n links (for testing)
  --max-idle <n>      Scroll rounds without new content before giving up (default: 6)
  --headful           Show the browser window while collecting
  -h, --help          Show this help

Anything after "--" is passed to yt-dlp unchanged.`;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killChildren();
    process.exit(130);
  });
}

const MARKER = '.fb-dumper-page';

function readMarker(dir) {
  try {
    return readFileSync(join(dir, MARKER), 'utf8').trim();
  } catch {
    return null;
  }
}

function pageDir(dest, slug, title) {
  const dirs = existsSync(dest)
    ? readdirSync(dest, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    : [];
  const name = title?.replace(/[/:\\]/g, '-').replace(/\s+/g, ' ').trim() || null;
  const isIdName = d => d === slug || d.endsWith(`[${slug}]`);
  const byName = name && dirs.find(d => d.normalize() === name.normalize());
  const existing = dirs.find(d => readMarker(join(dest, d)) === slug) ?? byName ?? dirs.find(isIdName);

  if (existing && name && !byName && isIdName(existing)) {
    renameSync(join(dest, existing), join(dest, name));
    console.log(`Renamed ${existing} -> ${name}`);
    return join(dest, name);
  }
  return join(dest, existing ?? name ?? slug);
}

function preparePageDir(dir, slug) {
  mkdirSync(dir, { recursive: true });
  if (readMarker(dir) !== slug) writeFileSync(join(dir, MARKER), `${slug}\n`);
}

async function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dest: { type: 'string' },
      out: { type: 'string' },
      tabs: { type: 'string', default: 'reels,videos' },
      cookies: { type: 'string' },
      profile: { type: 'string' },
      'collect-only': { type: 'boolean', default: false },
      'skip-collect': { type: 'boolean', default: false },
      'keep-codec': { type: 'boolean', default: false },
      'max-links': { type: 'string' },
      'max-idle': { type: 'string', default: '6' },
      headful: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [pageInput, ...ytDlpArgs] = positionals;
  if (opts.help || !pageInput) {
    console.log(USAGE);
    return opts.help ? 0 : 1;
  }

  const tabs = opts.tabs.split(',').map(t => t.trim()).filter(Boolean);
  const badTab = tabs.find(t => !['reels', 'videos'].includes(t));
  if (badTab) throw new Error(`Unknown tab "${badTab}", use reels and/or videos`);

  const { slug, tabUrls } = resolvePage(pageInput, tabs);
  const dest = resolve(opts.dest ?? join(ROOT, 'downloads'));
  const cacheDir = process.env.FB_DUMPER_CACHE ?? join(ROOT, '.cache');

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

  let outDir = opts.out ? resolve(opts.out) : null;
  if (!opts['skip-collect']) {
    if (!cookies.some(c => c.name === 'c_user')) {
      throw new Error('No Facebook login in these cookies (c_user cookie missing)');
    }

    const { links, title } = await collectLinks({
      tabUrls,
      cookies,
      headful: opts.headful,
      maxIdleRounds: Number(opts['max-idle']),
      maxLinks: opts['max-links'] ? Number(opts['max-links']) : Infinity,
    });

    outDir ??= pageDir(dest, slug, title);
    preparePageDir(outDir, slug);
    console.log(`Output:  ${outDir}`);

    const linksFile = join(outDir, 'links.txt');
    const merged = new Map();
    const previous = existsSync(linksFile) ? readFileSync(linksFile, 'utf8').split('\n') : [];
    for (const url of [...previous, ...links]) {
      const link = url && parseVideoLink(url);
      if (link && !merged.has(link.id)) merged.set(link.id, link.url);
    }
    writeFileSync(linksFile, [...merged.values()].join('\n') + '\n');
    console.log(`\n${links.length} links found, ${merged.size} in ${linksFile}`);
  } else {
    outDir ??= pageDir(dest, slug, null);
    console.log(`Output:  ${outDir}`);
  }

  if (opts['collect-only']) return 0;

  const linksFile = join(outDir, 'links.txt');
  if (!existsSync(linksFile)) throw new Error(`${linksFile} does not exist, run without --skip-collect first`);
  const code = await downloadAll({ linksFile, outDir, cookieArgs, extraArgs: ytDlpArgs });
  if (code !== 0) console.log(`Warning: yt-dlp exited with ${code}, some videos may be missing`);

  if (!opts['keep-codec']) {
    const { converted, failed } = await convertToH264(outDir);
    if (converted || failed) console.log(`Converted ${converted} videos to H.264${failed ? `, ${failed} failed` : ''}`);
  }

  const total = readdirSync(outDir).filter(f => f.endsWith('.mp4') && !f.startsWith('.')).length;
  console.log(`Done: ${total} videos in ${outDir}`);
  return code === 0 ? 0 : 2;
}

main().then(
  code => process.exit(code),
  err => {
    killChildren();
    console.error(`Error: ${err.message}`);
    process.exit(1);
  },
);
