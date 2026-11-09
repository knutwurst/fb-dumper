import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withBrowser } from './collect.js';
import { find, paginate, watchQuery } from './graphql.js';

export const IG = 'https://www.instagram.com';

const RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'stories', 'direct', 'audio']);

export function parseInstagram(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!/(^|\.)instagram\.com$/.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const audio = url.pathname.match(/\/(?:reels\/)?audio\/(\d+)/);
  if (audio) return { type: 'audio', id: audio[1], url: `${IG}/reels/audio/${audio[1]}/` };
  if (!parts.length || RESERVED.has(parts[0].toLowerCase())) {
    throw new Error(`Expected an Instagram profile or audio URL, got: ${input}`);
  }
  return { type: 'profile', username: parts[0] };
}

const day = time => new Date(Number(time) * 1000).toISOString().slice(0, 10).replaceAll('-', '');

function assertLoggedIn(page) {
  if (/\/accounts\/login|\/challenge\//.test(page.url())) {
    throw new Error(`Instagram redirected to ${page.url()}. Log in to Instagram in Chrome Canary and retry.`);
  }
}

function collectMedia(value, media) {
  if (Array.isArray(value)) return value.forEach(v => collectMedia(v, media));
  if (!value || typeof value !== 'object') return;
  if (typeof value.code === 'string' && value.media_type && value.taken_at) {
    const date = day(value.taken_at);
    const files = value.media_type === 8 ? value.carousel_media ?? [] : [value];
    files.forEach((item, i) => {
      const key = value.media_type === 8 ? `${value.code}_${i + 1}` : value.code;
      if (item.media_type === 2 && value.media_type !== 8) {
        media.videos.set(value.code, `${IG}/p/${value.code}/`);
      } else if (item.media_type === 2) {
        const url = item.video_versions?.[0]?.url;
        if (url) media.files.set(key, { key, url, date, video: true });
      } else {
        const url = item.image_versions2?.candidates?.[0]?.url;
        if (url) media.files.set(key, { key, url, date, video: false });
      }
    });
    return;
  }
  for (const child of Object.values(value)) collectMedia(child, media);
}

const profileName = (data, username) =>
  find(data, o => o.username === username && typeof o.full_name === 'string' && o.full_name)?.full_name ?? null;

const TABS = [
  { path: '', query: /^PolarisProfilePostsTabContentQuery_connection$/ },
  { path: 'reels/', query: /^PolarisProfileReelsTabContentQuery_connection$/ },
];

export function collectInstagram({ username, cookies, maxIdleRounds = 3, log = console.log }) {
  return withBrowser({ cookies }, async context => {
    const page = await context.newPage();
    const media = { videos: new Map(), files: new Map() };
    let title = null;
    const total = () => media.videos.size + media.files.size;
    const onResponse = async res => {
      if (!res.url().includes('/graphql')) return;
      const text = await res.text().catch(() => '');
      for (const line of text.split('\n').filter(l => l.startsWith('{'))) {
        try {
          const data = JSON.parse(line);
          collectMedia(data, media);
          title ??= profileName(data, username);
        } catch {}
      }
    };
    page.on('response', onResponse);

    for (const tab of TABS) {
      const url = `${IG}/${username}/${tab.path}`;
      const start = total();
      const progress = () => log(`  ${total() - start} links on this tab (${total()} total)`);
      const query = watchQuery(page, tab.query);
      log(`→ ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      assertLoggedIn(page);
      let idle = 0;
      while (idle < maxIdleRounds && !query.found()) {
        const before = total();
        await page.evaluate(async () => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          await new Promise(r => setTimeout(r, 2500));
        });
        idle = total() > before ? 0 : idle + 1;
        progress();
      }
      query.stop();
      const api = query.found();
      if (api) {
        await paginate(page, api, {
          onPage: (text, data) => {
            collectMedia(data, media);
            progress();
          },
          log,
        });
      }
    }
    page.off('response', onResponse);
    return { videos: [...media.videos.values()], files: [...media.files.values()], title };
  });
}

export function readAudio({ id, url, cookies, log = console.log }) {
  return withBrowser({ cookies }, async context => {
    const page = await context.newPage();
    const answer = page.waitForResponse(res => res.url().includes('/api/v1/clips/music/'), { timeout: 30000 });
    log(`→ ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    assertLoggedIn(page);
    const text = await (await answer).text();
    const payload = JSON.parse(text.slice(text.indexOf('{')));
    const meta = payload.payload?.metadata ?? payload.metadata;
    const asset = find(meta, o => typeof o.progressive_download_url === 'string');
    if (!asset) throw new Error(`No audio file found for ${url}`);
    const artist = meta?.original_sound_info?.ig_artist;
    const title =
      meta?.original_sound_info?.original_audio_title ??
      meta?.music_info?.music_asset_info?.title ??
      asset.title ??
      'Audio';
    return {
      id,
      src: asset.progressive_download_url,
      title,
      artist: meta?.music_info?.music_asset_info?.display_artist ?? artist?.full_name ?? null,
      username: artist?.username ?? null,
      fullName: artist?.full_name ?? null,
    };
  });
}

const EXT = { jpeg: 'jpg' };
const AUDIO_EXT = { mp4: 'm4a', 'x-m4a': 'm4a', mpeg: 'mp3', aac: 'aac' };

export async function saveFile(src, path, { audio = false } = {}) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const [, kind, type] = res.headers.get('content-type')?.match(/^(\w+)\/([\w-]+)/) ?? [];
  const ext = audio || kind === 'audio' ? AUDIO_EXT[type] ?? type : EXT[type] ?? type;
  const file = `${path}.${ext ?? 'bin'}`;
  const tmp = `${file}.part`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  renameSync(tmp, file);
  return file;
}

export async function downloadFiles({ files, outDir, concurrency = 4, log = console.log }) {
  const archive = join(outDir, 'photos-archive.txt');
  const done = new Set(existsSync(archive) ? readFileSync(archive, 'utf8').split('\n').filter(Boolean) : []);
  const todo = files.filter(f => !done.has(f.key));
  log(`Photos: ${todo.length} to download, ${files.length - todo.length} already there`);
  if (!todo.length) return { downloaded: 0, failed: 0 };

  mkdirSync(join(outDir, 'Fotos'), { recursive: true });
  let next = 0;
  let finished = 0;
  let failed = 0;
  const worker = async () => {
    while (next < todo.length) {
      const file = todo[next++];
      try {
        const saved = await saveFile(file.url, join(outDir, file.video ? '' : 'Fotos', `${file.date}_${file.key}`));
        appendFileSync(archive, `${file.key}\n`);
        log(`Photo ${++finished}/${todo.length}: ${saved.split('/').pop()}`);
      } catch (err) {
        failed++;
        log(`Photo ${++finished}/${todo.length} failed: ${file.key}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return { downloaded: todo.length - failed, failed };
}
