const sleep = ms => new Promise(r => setTimeout(r, ms));

export function watchQuery(page, name) {
  let found = null;
  const onRequest = req => {
    if (found || !req.url().includes('/api/graphql')) return;
    const form = new URLSearchParams(req.postData() ?? '');
    if (name.test(form.get('fb_api_req_friendly_name') ?? '')) {
      found = { url: req.url(), form, lsd: req.headers()['x-fb-lsd'] ?? form.get('lsd') ?? '' };
    }
  };
  page.on('request', onRequest);
  return {
    found: () => found,
    stop: () => page.off('request', onRequest),
  };
}

function parse(text) {
  const lines = text.split('\n').filter(l => l.startsWith('{'));
  if (!lines.length) return null;
  try {
    const data = lines.map(l => JSON.parse(l));
    return data[0].data ? data : null;
  } catch {
    return null;
  }
}

export async function graphql(page, query, variables, { retries = 5, log = console.log } = {}) {
  const form = new URLSearchParams(query.form);
  const name = form.get('fb_api_req_friendly_name');
  form.set('variables', JSON.stringify(variables));
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': name, 'x-fb-lsd': query.lsd };
  for (let attempt = 0; ; attempt++) {
    const text = await page.evaluate(
      async ([url, body, headers]) => {
        try {
          return await (await fetch(url, { method: 'POST', body, headers, credentials: 'include' })).text();
        } catch {
          return '';
        }
      },
      [query.url, form.toString(), headers],
    );
    const data = parse(text);
    if (data) return { text, data };
    if (attempt >= retries) throw new Error(`Facebook did not answer ${name}`);
    const wait = 10 * 2 ** attempt;
    log(`  Facebook is slowing down, waiting ${wait}s`);
    await sleep(wait * 1000);
  }
}

export function find(value, test) {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value) && test(value)) return value;
  for (const child of Object.values(value)) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

export async function paginate(page, query, { variables = {}, onPage, done = () => false, log }) {
  const base = { ...JSON.parse(query.form.get('variables')), ...variables };
  const seen = new Set();
  let cursor = null;
  do {
    const { text, data } = await graphql(page, query, { ...base, cursor }, { log });
    onPage(text);
    const info = find(data, o => o.page_info)?.page_info;
    cursor = info?.has_next_page && !seen.has(info.end_cursor) ? info.end_cursor : null;
    seen.add(cursor);
  } while (cursor && !done());
}
