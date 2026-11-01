import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { assertLoggedIn, withBrowser } from './collect.js';
import { parsePhotoLink } from './page.js';

const IMAGE = 'img[data-visualcompletion="media-vc-image"]';

function unescape(raw) {
  return raw === undefined ? null : JSON.parse(`"${raw}"`);
}

function photoInfo(html, id) {
  let date = null;
  for (const m of html.matchAll(/"created_time":(\d+)/g)) {
    if (html.slice(Math.max(0, m.index - 400), m.index).includes(`"${id}"`)) {
      date = new Date(Number(m[1]) * 1000).toISOString().slice(0, 10).replaceAll('-', '');
      break;
    }
  }
  return {
    date,
    ownerId: html.match(/"owner":\{"__typename":"\w+","id":"(\d+)"/)?.[1] ?? null,
    ownerName: unescape(html.match(/"owner":\{"__typename":"\w+","name":"((?:[^"\\]|\\.)*)"/)?.[1]),
  };
}

export async function readPhotoPage(page, { id, url }) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  assertLoggedIn(page);
  const image = await page.waitForSelector(IMAGE, { timeout: 20000 });
  await page.waitForFunction(img => img.complete && img.naturalWidth > 0, image, { timeout: 20000 });
  const src = await image.evaluate(img => img.currentSrc || img.src);
  return { src, ...photoInfo(await page.content(), id) };
}

export function photoOwner(link, cookies) {
  return withBrowser({ cookies }, async context => readPhotoPage(await context.newPage(), link));
}

export function downloadPhotos({ photos, outDir, cookies, concurrency = 3, log = console.log }) {
  const dir = join(outDir, 'Fotos');
  const archive = join(outDir, 'photos-archive.txt');
  const done = new Set(existsSync(archive) ? readFileSync(archive, 'utf8').split('\n').filter(Boolean) : []);
  const links = photos.map(parsePhotoLink).filter(Boolean);
  const todo = links.filter(link => !done.has(link.id));
  log(`Photos: ${todo.length} to download, ${links.length - todo.length} already there`);
  if (!todo.length) return Promise.resolve({ downloaded: 0, failed: 0 });

  mkdirSync(dir, { recursive: true });
  return withBrowser({ cookies }, async context => {
    let next = 0;
    let finished = 0;
    let failed = 0;
    const worker = async () => {
      const page = await context.newPage();
      while (next < todo.length) {
        const link = todo[next++];
        try {
          const { src, date } = await readPhotoPage(page, link);
          const res = await fetch(src);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const name = `${date ?? 'undated'}_${link.id}${extname(new URL(src).pathname) || '.jpg'}`;
          const tmp = join(dir, `.${name}.part`);
          writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
          renameSync(tmp, join(dir, name));
          appendFileSync(archive, `${link.id}\n`);
          log(`Photo ${++finished}/${todo.length}: ${name}`);
        } catch (err) {
          failed++;
          log(`Photo ${++finished}/${todo.length} failed: ${link.url}: ${err.message.split('\n')[0]}`);
        }
      }
      await page.close();
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    return { downloaded: todo.length - failed, failed };
  });
}
