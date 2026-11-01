import { chromium } from 'playwright';
import { parsePhotoLink, parseVideoLink } from './page.js';

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

export function collectLinks({ tabs, cookies, headful = false, maxIdleRounds = 3, maxLinks = Infinity, log = console.log }) {
  return withBrowser({ cookies, headful }, async context => {
    const page = await context.newPage();
    const found = { videos: new Map(), photos: new Map() };
    const total = () => found.videos.size + found.photos.size;
    let title = null;
    for (const tab of tabs) {
      log(`→ ${tab.url}`);
      await page.goto(tab.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      assertLoggedIn(page);

      const parse = tab.kind === 'photos' ? parsePhotoLink : parseVideoLink;
      const target = found[tab.kind];
      const tabStart = target.size;
      let idle = 0;
      while (idle < maxIdleRounds && target.size < maxLinks) {
        const before = target.size;
        for (const href of await page.$$eval('a[href]', as => as.map(a => a.href))) {
          const link = parse(href);
          if (link && !target.has(link.id)) target.set(link.id, link.url);
        }
        await page.evaluate(async () => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          await new Promise(r => setTimeout(r, 2500));
        });
        idle = target.size > before ? 0 : idle + 1;
        log(`  ${target.size - tabStart} links on this tab (${total()} total)`);
      }
      title ??=
        cleanTitle(await page.title()) ??
        cleanTitle(await page.$$eval('h1', hs => hs.map(h => h.innerText.trim()).find(Boolean) ?? ''));
    }
    return {
      links: [...found.videos.values()].slice(0, maxLinks),
      photos: [...found.photos.values()].slice(0, maxLinks),
      title,
    };
  });
}
