#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collectLinks } from './collect.js';
import { convertToH264 } from './convert.js';
import { loadCookieFile, writeNetscape } from './cookie-file.js';
import { INSTAGRAM_FORMATS, downloadAll } from './download.js';
import { readChromeCookies } from './chrome.js';
import { findProfileDir, readFacebookCookies } from './firefox.js';
import { collectInstagram, downloadFiles, parseInstagram, readAudio, saveFile } from './instagram.js';
import { removeMacJunk } from './junk.js';
import { parsePhotoLink, parseVideoLink, resolvePage } from './page.js';
import { downloadPhotos, photoOwner } from './photos.js';
import { killChildren, run } from './proc.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: fb-dumper <page-or-profile-url|reel-url|photo-url|instagram-url> [options]

Collects every reel, video, photo and album of a Facebook page or profile with your Firefox login,
downloads the videos with yt-dlp, converts anything that is not H.264 and saves
the photos in full size into a Fotos folder.
A single reel, video or photo URL is saved into the folder of its page.
An Instagram profile URL dumps all posts and reels, an Instagram audio URL saves
the audio track. Instagram uses the login of Chrome Canary or Chrome.

Options:
  --dest <dir>        Base directory, each page gets its own folder in it (default: downloads)
  --out <dir>         Exact output directory, overrides --dest
  --tabs <list>       Tabs to scan, comma separated: reels,videos,photos (default: all)
  --cookies <file>    Use a cookie export (cookies.txt or JSON) instead of reading Firefox
  --profile <dir>     Firefox profile directory (default: auto-detect)
  --collect-only      Only write links.txt and photos.txt, do not download
  --skip-collect      Only download what is already in links.txt and photos.txt
  --quality <q>       hd: Facebook's progressive file, mostly 720p H.264 (default)
                      full: highest resolution, mostly AV1
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

function preparePageDir(dir, slug, overwrite = true) {
  mkdirSync(dir, { recursive: true });
  const marker = readMarker(dir);
  if (slug && marker !== slug && (overwrite || marker === null)) writeFileSync(join(dir, MARKER), `${slug}\n`);
}

function readLines(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function mergeLinks(linksFile, links, parse = parseVideoLink) {
  const merged = new Map();
  for (const url of [...readLines(linksFile), ...links]) {
    const link = parse(url);
    if (link && !merged.has(link.id)) merged.set(link.id, link.url);
  }
  writeFileSync(linksFile, [...merged.values()].join('\n') + '\n');
  return merged.size;
}

async function finish(code, keepCodec, { onlyId = null, photosFailed = 0 } = {}) {
  if (code !== 0) console.log(`Warning: yt-dlp exited with ${code}, some videos may be missing`);
  if (photosFailed) console.log(`Warning: ${photosFailed} photos failed`);

  if (!keepCodec) {
    const { converted, failed } = await convertToH264(outDir);
    if (converted || failed) console.log(`Converted ${converted} videos to H.264${failed ? `, ${failed} failed` : ''}`);
  }

  cleanUp();
  const matches = f => !f.startsWith('.') && (!onlyId || f.includes(`_${onlyId}.`));
  const videos = readdirSync(outDir).filter(f => f.endsWith('.mp4') && matches(f)).length;
  const photoDir = join(outDir, 'Fotos');
  const photos = existsSync(photoDir) ? readdirSync(photoDir).filter(matches).length : 0;
  console.log(`Done: ${videos} videos, ${photos} photos in ${outDir}`);
  return code === 0 && !photosFailed ? 0 : 2;
}

async function dumpSingle(link, { dest, out, cookieArgs, cacheDir, quality, keepCodec, ytDlpArgs }) {
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
  preparePageDir(outDir, out ? null : uploaderId, false);
  console.log(`Output:  ${outDir}`);
  mergeLinks(join(outDir, 'links.txt'), [link.url]);

  mkdirSync(cacheDir, { recursive: true });
  const batch = join(cacheDir, 'single.txt');
  writeFileSync(batch, `${link.url}\n`);
  const code = await downloadAll({ linksFile: batch, outDir, cookieArgs, quality, extraArgs: ytDlpArgs });
  return finish(code, keepCodec, { onlyId: link.id });
}

async function dumpSinglePhoto(link, { dest, out, cookies }) {
  console.log(`Photo:   ${link.url}`);
  const { ownerId, ownerName } = await photoOwner(link, cookies);
  outDir = out ?? (ownerId ? pageDir(dest, ownerId, ownerName) : join(dest, 'photos'));
  preparePageDir(outDir, out ? null : ownerId, false);
  console.log(`Output:  ${outDir}`);
  mergeLinks(join(outDir, 'photos.txt'), [link.url], parsePhotoLink);
  const { failed } = await downloadPhotos({ photos: [link.url], outDir, cookies });
  return finish(0, true, { onlyId: link.id, photosFailed: failed });
}

async function dumpInstagram(target, { dest, out, cacheDir, tabs, quality, keepCodec, collectOnly, ytDlpArgs }) {
  const cookies = readChromeCookies('instagram.com', cacheDir);
  if (!cookies.some(c => c.name === 'sessionid')) throw new Error('No Instagram login found in Chrome');
  const netscape = join(cacheDir, 'instagram-cookies.txt');
  writeNetscape(cookies, netscape);
  const cookieArgs = ['--cookies', netscape];
  const folder = (username, name) => pageDir(dest, `instagram:${username}`, `${name ?? username} (Instagram)`);

  if (target.type === 'audio') {
    const audio = await readAudio({ ...target, cookies });
    outDir = out ?? (audio.username ? folder(audio.username, audio.fullName) : join(dest, 'Instagram Audio'));
    preparePageDir(outDir, out || !audio.username ? null : `instagram:${audio.username}`, false);
    console.log(`Output:  ${outDir}`);
    const dir = join(outDir, 'Audio');
    mkdirSync(dir, { recursive: true });
    const name = `${audio.title}${audio.artist ? ` - ${audio.artist}` : ''} [${audio.id}]`.replace(/[/:\\]/g, '-');
    const file = await saveFile(audio.src, join(dir, name), { audio: true });
    console.log(`Audio:   ${file}`);
    cleanUp();
    console.log(`Done: 0 videos, 0 photos, 1 audio in ${outDir}`);
    return 0;
  }

  console.log(`Page:    instagram.com/${target.username}`);
  const collected = await collectInstagram({ username: target.username, cookies });
  const { title } = collected;
  const videos = tabs.some(t => t !== 'photos') ? collected.videos : [];
  const files = tabs.includes('photos') ? collected.files : [];
  outDir = out ?? folder(target.username, title);
  preparePageDir(outDir, out ? null : `instagram:${target.username}`);
  console.log(`Output:  ${outDir}`);
  const size = mergeLinks(join(outDir, 'links.txt'), videos, parseInstagramLink);
  console.log(`\n${videos.length + files.length} links found, ${size + files.length} in links.txt and photos`);
  if (collectOnly) {
    cleanUp();
    return 0;
  }
  if (!videos.length && !files.length) throw new Error('No posts or reels found on this profile');

  const linksFile = join(outDir, 'links.txt');
  const code = videos.length
    ? await downloadAll({ linksFile, outDir, cookieArgs, quality, formats: INSTAGRAM_FORMATS, extraArgs: ytDlpArgs })
    : 0;
  const { failed } = await downloadFiles({ files, outDir });
  return finish(code, keepCodec, { photosFailed: failed });
}

const parseInstagramLink = url => {
  const m = url.match(/instagram\.com\/(?:p|reel)\/([\w-]+)/);
  return m ? { id: m[1], url: `https://www.instagram.com/p/${m[1]}/` } : null;
};

async function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dest: { type: 'string' },
      out: { type: 'string' },
      tabs: { type: 'string', default: 'reels,videos,photos' },
      cookies: { type: 'string' },
      profile: { type: 'string' },
      'collect-only': { type: 'boolean', default: false },
      'skip-collect': { type: 'boolean', default: false },
      quality: { type: 'string', default: 'hd' },
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
  const badTab = tabs.find(t => !['reels', 'videos', 'photos'].includes(t));
  if (badTab) throw new Error(`Unknown tab "${badTab}", use reels, videos and/or photos`);
  if (!['hd', 'full'].includes(opts.quality)) throw new Error(`Unknown quality "${opts.quality}", use hd or full`);

  const dest = resolve(opts.dest ?? join(ROOT, 'downloads'));
  const cacheDir = process.env.FB_DUMPER_CACHE ?? join(ROOT, '.cache');

  const instagram = parseInstagram(pageInput);
  if (instagram) {
    return dumpInstagram(instagram, {
      dest,
      out: opts.out ? resolve(opts.out) : null,
      cacheDir,
      tabs,
      quality: opts.quality,
      keepCodec: opts['keep-codec'],
      collectOnly: opts['collect-only'],
      ytDlpArgs,
    });
  }

  const single = parseVideoLink(pageInput);
  const singlePhoto = !single && parsePhotoLink(pageInput);
  const { slug, tabs: pageTabs } = single || singlePhoto ? { slug: null, tabs: [] } : resolvePage(pageInput, tabs);

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
      quality: opts.quality,
      keepCodec: opts['keep-codec'],
      ytDlpArgs,
    });
  }
  if (singlePhoto) return dumpSinglePhoto(singlePhoto, { dest, out: opts.out ? resolve(opts.out) : null, cookies });
  console.log(`Page:    ${slug}`);

  outDir = opts.out ? resolve(opts.out) : null;
  if (!opts['skip-collect']) {
    if (!cookies.some(c => c.name === 'c_user')) {
      throw new Error('No Facebook login in these cookies (c_user cookie missing)');
    }

    const { links, photos, title } = await collectLinks({
      tabs: pageTabs,
      cookies,
      headful: opts.headful,
      maxIdleRounds: Number(opts['max-idle']),
      maxLinks: opts['max-links'] ? Number(opts['max-links']) : Infinity,
    });

    outDir ??= pageDir(dest, slug, title);
    preparePageDir(outDir, slug);
    console.log(`Output:  ${outDir}`);

    const size =
      mergeLinks(join(outDir, 'links.txt'), links) + mergeLinks(join(outDir, 'photos.txt'), photos, parsePhotoLink);
    console.log(`\n${links.length + photos.length} links found, ${size} in links.txt and photos.txt`);
  } else {
    outDir ??= pageDir(dest, slug, null);
    console.log(`Output:  ${outDir}`);
  }

  if (opts['collect-only']) {
    cleanUp();
    return 0;
  }

  const linksFile = join(outDir, 'links.txt');
  const videoLinks = tabs.some(t => t !== 'photos') ? readLines(linksFile) : [];
  const photoLinks = tabs.includes('photos') ? readLines(join(outDir, 'photos.txt')) : [];
  if (!videoLinks.length && !photoLinks.length) throw new Error('No reels, videos or photos found on this page');

  const code = videoLinks.length
    ? await downloadAll({ linksFile, outDir, cookieArgs, quality: opts.quality, extraArgs: ytDlpArgs })
    : 0;
  const { failed } = photoLinks.length ? await downloadPhotos({ photos: photoLinks, outDir, cookies }) : { failed: 0 };
  return finish(code, opts['keep-codec'] || !videoLinks.length, { photosFailed: failed });
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
