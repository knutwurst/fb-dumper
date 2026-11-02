import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { assertLoggedIn, withBrowser } from './collect.js';
import { find, graphql, watchQuery } from './graphql.js';
import { parsePhotoLink } from './page.js';

const IMAGE = 'img[data-visualcompletion="media-vc-image"]';

function unescape(raw) {
  return raw === undefined ? null : JSON.parse(`"${raw}"`);
}

const day = time => new Date(Number(time) * 1000).toISOString().slice(0, 10).replaceAll('-', '');

function photoInfo(html, id) {
  let date = null;
  for (const m of html.matchAll(/"created_time":(\d+)/g)) {
    if (html.slice(Math.max(0, m.index - 400), m.index).includes(`"${id}"`)) {
      date = day(m[1]);
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

async function viewerQuery(page, link) {
  const query = watchQuery(page, /^CometPhotoRootContentQuery$/);
  try {
    await readPhotoPage(page, link);
    await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 20 && !query.found(); i++) await page.waitForTimeout(250);
    return query.found();
  } catch {
    return null;
  } finally {
    query.stop();
  }
}

async function readPhotoApi(page, query, { id }) {
  const variables = { ...JSON.parse(query.form.get('variables')), nodeID: id };
  const { data } = await graphql(page, query, variables);
  const media = find(data, o => o.id === id && o.image?.uri);
  if (!media) throw new Error('no image in the answer');
  return { src: media.image.uri, date: media.created_time ? day(media.created_time) : null };
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
    const apiPage = await context.newPage();
    const query = todo.length > 1 ? await viewerQuery(apiPage, todo[0]) : null;
    let next = 0;
    let finished = 0;
    let failed = 0;
    const worker = async () => {
      const page = query ? null : await context.newPage();
      while (next < todo.length) {
        const link = todo[next++];
        try {
          const { src, date } = query ? await readPhotoApi(apiPage, query, link) : await readPhotoPage(page, link);
          const res = await fetch(src);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const type = res.headers.get('content-type')?.match(/^image\/(\w+)/)?.[1];
          const ext = type ? `.${type.replace('jpeg', 'jpg')}` : extname(new URL(src).pathname) || '.jpg';
          const name = `${date ?? 'undated'}_${link.id}${ext}`;
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
      await page?.close();
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    return { downloaded: todo.length - failed, failed };
  });
}
