#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collectLinks } from './collect.js';
import { convertToH264 } from './convert.js';
import { loadCookieFile, writeNetscape } from './cookie-file.js';
import { downloadAll } from './download.js';
import { findProfileDir, readFacebookCookies } from './firefox.js';
import { removeMacJunk } from './junk.js';
import { parseVideoLink, resolvePage } from './page.js';
import { killChildren, run } from './proc.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: fb-dumper <page-url|reel-url> [options]

Collects every reel/video link of a Facebook page with your Firefox login,
downloads them all with yt-dlp and converts anything that is not H.264.
A single reel or video URL is saved into the folder of its page.

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
  --max-idle <n>      Scroll rounds without new content before giving up (default: 3)
  --headful           Show the browser window while collecting
  -h, --help          Show this help

Anything after "--" is passed to yt-dlp unchanged.`;

let outDir = null;

function cleanUp() {
  if (!outDir) return;
  const sidecar = join(dirname(outDir), `._${basename(outDir)}`);
  const removed = removeMacJunk(outDir) + (existsSync(sidecar) ? (rmSync(sidecar), 1) : 0);
  if (removed) console.log(`Removed ${removed} macOS metadata files`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killChildren();
    cleanUp();
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
  if (slug && readMarker(dir) !== slug) writeFileSync(join(dir, MARKER), `${slug}\n`);
}

function mergeLinks(linksFile, links) {
  const merged = new Map();
  const previous = existsSync(linksFile) ? readFileSync(linksFile, 'utf8').split('\n') : [];
  for (const url of [...previous, ...links]) {
    const link = url && parseVideoLink(url);
    if (link && !merged.has(link.id)) merged.set(link.id, link.url);
  }
  writeFileSync(linksFile, [...merged.values()].join('\n') + '\n');
  return merged.size;
}

async function finish(code, keepCodec, onlyId = null) {
  if (code !== 0) console.log(`Warning: yt-dlp exited with ${code}, some videos may be missing`);

  if (!keepCodec) {
    const { converted, failed } = await convertToH264(outDir);
    if (converted || failed) console.log(`Converted ${converted} videos to H.264${failed ? `, ${failed} failed` : ''}`);
  }

  cleanUp();
  const total = readdirSync(outDir).filter(
    f => f.endsWith('.mp4') && !f.startsWith('.') && (!onlyId || f.includes(`_${onlyId}.`)),
  ).length;
  console.log(`Done: ${total} videos in ${outDir}`);
  return code === 0 ? 0 : 2;
}

async function dumpSingle(link, { dest, out, cookieArgs, cacheDir, keepCodec, ytDlpArgs }) {
  console.log(`Video:   ${link.url}`);
  const { out: meta } = await run(
    'yt-dlp',
    [...cookieArgs, '--skip-download', '--no-warnings', '--print', '%(uploader_id)s\t%(uploader)s', link.url],
    { capture: true },
  );
  const [uploaderId = null, uploader = null] = (meta.trim().split('\n').pop() ?? '')
    .split('\t')
    .map(v => (v && v !== 'NA' ? v : null));

  outDir = out ?? (uploaderId ? pageDir(dest, uploaderId, uploader) : join(dest, 'reels'));
  preparePageDir(outDir, out ? null : uploaderId);
  console.log(`Output:  ${outDir}`);
  mergeLinks(join(outDir, 'links.txt'), [link.url]);

  mkdirSync(cacheDir, { recursive: true });
  const batch = join(cacheDir, 'single.txt');
  writeFileSync(batch, `${link.url}\n`);
  const code = await downloadAll({ linksFile: batch, outDir, cookieArgs, extraArgs: ytDlpArgs });
  return finish(code, keepCodec, link.id);
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
      'max-idle': { type: 'string', default: '3' },
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

  const single = parseVideoLink(pageInput);
  const { slug, tabUrls } = single ? { slug: null, tabUrls: [] } : resolvePage(pageInput, tabs);
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
  if (single) {
    return dumpSingle(single, {
      dest,
      out: opts.out ? resolve(opts.out) : null,
      cookieArgs,
      cacheDir,
      keepCodec: opts['keep-codec'],
      ytDlpArgs,
    });
  }
  console.log(`Page:    ${slug}`);

  outDir = opts.out ? resolve(opts.out) : null;
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
    const size = mergeLinks(linksFile, links);
    console.log(`\n${links.length} links found, ${size} in ${linksFile}`);
  } else {
    outDir ??= pageDir(dest, slug, null);
    console.log(`Output:  ${outDir}`);
  }

  if (opts['collect-only']) {
    cleanUp();
    return 0;
  }

  const linksFile = join(outDir, 'links.txt');
  if (!existsSync(linksFile)) throw new Error(`${linksFile} does not exist, run without --skip-collect first`);
  if (!readFileSync(linksFile, 'utf8').trim()) throw new Error('No reels or videos found on this page');
  const code = await downloadAll({ linksFile, outDir, cookieArgs, extraArgs: ytDlpArgs });
  return finish(code, opts['keep-codec']);
}

main().then(
  code => process.exit(code),
  err => {
    killChildren();
    cleanUp();
    console.error(`Error: ${err.message}`);
    process.exit(1);
  },
);
