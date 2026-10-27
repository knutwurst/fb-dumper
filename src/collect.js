import { chromium } from 'playwright';
import { parseVideoLink } from './page.js';

function assertLoggedIn(page) {
  const url = page.url();
  if (/\/(login|checkpoint)\b/.test(url)) {
    throw new Error(`Facebook redirected to ${url}. Log in to Facebook in Firefox (or solve the check there) and retry.`);
  }
}

export async function collectLinks({ tabUrls, cookies, headful = false, maxIdleRounds = 6, maxLinks = Infinity, log = console.log }) {
  const browser = await chromium.launch({ channel: 'chrome', headless: !headful });
  try {
    const major = browser.version().split('.')[0];
    const context = await browser.newContext({
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      viewport: { width: 1280, height: 1600 },
    });
    await context.addCookies(cookies);
    const page = await context.newPage();

    const found = new Map();
    for (const tabUrl of tabUrls) {
      log(`→ ${tabUrl}`);
      await page.goto(tabUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      assertLoggedIn(page);

      const tabStart = found.size;
      let idle = 0;
      while (idle < maxIdleRounds && found.size < maxLinks) {
        const before = found.size;
        for (const href of await page.$$eval('a[href]', as => as.map(a => a.href))) {
          const link = parseVideoLink(href);
          if (link && !found.has(link.id)) found.set(link.id, link.url);
        }
        const grew = await page.evaluate(async () => {
          const h = document.documentElement.scrollHeight;
          window.scrollTo(0, h);
          await new Promise(r => setTimeout(r, 2500));
          return document.documentElement.scrollHeight > h;
        });
        idle = found.size > before || grew ? 0 : idle + 1;
        log(`  ${found.size - tabStart} links on this tab (${found.size} total)`);
      }
    }
    return [...found.values()].slice(0, maxLinks);
  } finally {
    await browser.close();
  }
}
