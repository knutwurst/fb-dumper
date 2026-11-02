import { chromium } from 'playwright';
import { paginate, watchQuery } from './graphql.js';
import { FB, parsePhotoLink, parseVideoLink } from './page.js';

export function assertLoggedIn(page) {
  const url = page.url();
  if (/\/(login|checkpoint)\b/.test(url)) {
    throw new Error(`Facebook redirected to ${url}. Log in to Facebook in Firefox (or solve the check there) and retry.`);
  }
}

function cleanTitle(raw) {
  const title = raw
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*\|\s*Facebook\s*$/i, '')
    .replace(/\s+(Reels|Videos|Fotos|Photos)\s*$/i, '')
    .trim();
  return title && title.toLowerCase() !== 'facebook' ? title : null;
}

export async function withBrowser({ cookies, headful = false }, fn) {
  const browser = await chromium.launch({ channel: 'chrome', headless: !headful });
  try {
    const major = browser.version().split('.')[0];
    const context = await browser.newContext({
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      viewport: { width: 1280, height: 1600 },
    });
    await context.addCookies(cookies);
    return await fn(context);
  } finally {
    await browser.close();
  }
}

const QUERY = {
  reels: /Reels\w*PaginationQuery$/,
  videos: /Videos\w*PaginationQuery$/,
  photos: /Photos\w*PaginationQuery$/,
  albums: /Albums\w*PaginationQuery$/,
  album: /Album\w*GridView\w*PaginationQuery$/,
};

const ids = (text, re) => [...text.matchAll(re)].map(m => m[1]);
const PHOTO_ID = /"__typename":"Photo","id":"(\d+)"/g;
const VIDEO_ID = /"__typename":"Video","id":"(\d+)"/g;

function fromText(tab, text) {
  const photos = () => ids(text, PHOTO_ID).map(id => ['photos', `${FB}/photo/?fbid=${id}`]);
  const videos = () => ids(text, VIDEO_ID).map(id => ['videos', `${FB}/watch/?v=${id}`]);
  if (tab === 'reels') return ids(text, /reel\\?\/(\d+)/g).map(id => ['videos', `${FB}/reel/${id}`]);
  if (tab === 'videos') return videos();
  if (tab === 'photos') return photos();
  if (tab === 'albums') return ids(text, /"__typename":"Album","id":"(\d+)"/g).map(id => ['albums', id]);
  return [...photos(), ...videos()];
}

function fromLinks(tab, hrefs) {
  const found = [];
  for (const href of hrefs) {
    if (tab === 'albums') {
      const m = href.match(/media\/set\/?\?set=a\.(\d+)/);
      if (m) found.push(['albums', m[1]]);
      continue;
    }
    const photo = (tab === 'photos' || tab === 'album') && parsePhotoLink(href);
    if (photo) found.push(['photos', photo.url]);
    const video = tab !== 'photos' && parseVideoLink(href);
    if (video) found.push(['videos', video.url]);
  }
  return found;
}

const albumUrl = id => `${FB}/media/set/?set=a.${id}&type=3`;

export function collectLinks({ tabs, cookies, headful = false, maxIdleRounds = 3, maxLinks = Infinity, log = console.log }) {
  return withBrowser({ cookies, headful }, async context => {
    const page = await context.newPage();
    const found = { videos: new Map(), photos: new Map(), albums: new Map() };
    const total = () => found.videos.size + found.photos.size;
    const full = () => total() >= maxLinks;
    const add = items => {
      let added = 0;
      for (const [kind, value] of items) {
        const id = kind === 'albums' ? value : (kind === 'photos' ? parsePhotoLink : parseVideoLink)(value)?.id;
        if (id && !found[kind].has(id)) {
          found[kind].set(id, value);
          added++;
        }
      }
      return added;
    };
    let title = null;

    const visit = async (tab, url) => {
      const start = total();
      const progress = () =>
        log(tab === 'albums' ? `  ${found.albums.size} albums` : `  ${total() - start} links on this tab (${total()} total)`);
      const query = watchQuery(page, QUERY[tab]);
      log(`→ ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      assertLoggedIn(page);
      title ??=
        cleanTitle(await page.title()) ??
        cleanTitle(await page.$$eval('h1', hs => hs.map(h => h.innerText.trim()).find(Boolean) ?? ''));

      let idle = 0;
      while (idle < maxIdleRounds && !query.found() && !full()) {
        const added = add(fromLinks(tab, await page.$$eval('a[href]', as => as.map(a => a.href))));
        await page.evaluate(async () => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          await new Promise(r => setTimeout(r, 2500));
        });
        idle = added ? 0 : idle + 1;
        progress();
      }
      add(fromLinks(tab, await page.$$eval('a[href]', as => as.map(a => a.href))));
      query.stop();
      const api = query.found();
      if (api && !full()) {
        await paginate(page, api, {
          onPage: text => {
            add(fromText(tab, text));
            progress();
          },
          done: full,
          log,
        });
      }
      return api;
    };

    for (const tab of tabs) await visit(tab.name, tab.url);

    const albums = [...found.albums.keys()];
    let albumQuery = null;
    for (const [i, id] of albums.entries()) {
      if (full()) break;
      if (albumQuery) {
        const start = total();
        log(`→ ${albumUrl(id)}`);
        await paginate(page, albumQuery, {
          variables: { id },
          onPage: text => {
            add(fromText('album', text));
            log(`  ${total() - start} links in album ${i + 1}/${albums.length} (${total()} total)`);
          },
          done: full,
          log,
        });
      } else {
        albumQuery = await visit('album', albumUrl(id));
      }
    }

    return {
      links: [...found.videos.values()].slice(0, maxLinks),
      photos: [...found.photos.values()].slice(0, maxLinks),
      title,
    };
  });
}
