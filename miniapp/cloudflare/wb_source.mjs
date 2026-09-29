// Narrow, authenticated egress for the existing WB scanner. No user data or
// Telegram credentials are stored here; only public WB catalogue JSON passes.
const SEARCH = 'https://search.wb.ru/exactmatch/ru/common/v9/search';
const CATALOG = 'https://catalog.wb.ru/catalog';
const CARDS = 'https://card.wb.ru/cards/v4/detail';
const COMMON = new Set(['appType', 'curr', 'dest', 'spp', 'lang']);
const SEARCH_KEYS = new Set([...COMMON, 'query', 'sort', 'page', 'resultset',
  'ab_testing', 'suppressSpellcheck']);
const CARD_KEYS = new Set([...COMMON, 'nm']);
const HEADERS = {'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9'};

function targetUrl(url) {
  const path = url.pathname;
  let upstream;
  let allowed;
  if (path === '/search') {
    if (!url.searchParams.get('query') ||
        url.searchParams.get('query').length > 100) return null;
    upstream = SEARCH;
    allowed = SEARCH_KEYS;
  } else if (path.startsWith('/catalog/')) {
    const shard = path.slice('/catalog/'.length);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(shard)) return null;
    upstream = `${CATALOG}/${shard}/catalog`;
    allowed = SEARCH_KEYS;
  } else if (path === '/cards') {
    const ids = (url.searchParams.get('nm') || '').split(';');
    if (!ids.length || ids.length > 20 ||
        ids.some(id => !/^\d{1,12}$/.test(id))) return null;
    upstream = CARDS;
    allowed = CARD_KEYS;
  } else {
    return null;
  }
  if ([...url.searchParams.keys()].some(key => !allowed.has(key))) return null;
  const page = url.searchParams.get('page');
  const dest = url.searchParams.get('dest');
  if ((page && !/^[1-5]$/.test(page)) ||
      (dest && !/^-?\d{1,10}$/.test(dest))) return null;
  const target = new URL(upstream);
  target.search = url.searchParams.toString();
  return target;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') return new Response('Method not allowed', {status: 405});
    const credential = request.headers.get('authorization');
    if (!env.WB_SOURCE_KEY || credential !== `Bearer ${env.WB_SOURCE_KEY}`)
      return new Response('Unauthorized', {status: 401});
    const target = targetUrl(new URL(request.url));
    if (!target) return new Response('Bad request', {status: 400});
    try {
      const response = await fetch(target.toString(), {headers: HEADERS,
        redirect: 'manual', signal: AbortSignal.timeout(12000)});
      const body = await response.arrayBuffer();
      if (body.byteLength > 2_000_000)
        return new Response('Source response too large', {status: 502});
      return new Response(body, {status: response.status, headers: {
        'content-type': response.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      }});
    } catch {
      return new Response('Source unavailable', {status: 502});
    }
  },
};
