// Product search for the Groceries tab. The frame never talks to Woolworths or Coles itself:
// this proxy fans out, normalises a few fields, and caches them briefly. Nothing here logs in
// or checks out. Prices are a guide for the list, not a cart.
//
// Coles: public website BFF (the subscription key is the one shipped in coles.com.au, not a
// household secret). Store prices follow COLES_STORE_ID (default 0584).
// Woolworths: POST /apis/ui/Search/products after a bootstrap cookie. Akamai often refuses
// datacenter addresses; that store then drops out and Coles (or a plain typed item) still works.
// Woolworths prices are whatever catalogue the anonymous session gets. There is no postcode.
import { mergeProducts, money } from '../shared/product.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WW = 'https://www.woolworths.com.au';
const COLES = 'https://www.coles.com.au';
// Public client key from the Coles website. Override with COLES_SUBSCRIPTION_KEY when it rotates.
const COLES_KEY = 'eae83861d1cd4de6bb9cd8a2cd6f041e';
const PER_STORE = 8;
const CACHE_S = 600;
const FETCH_MS = 8000;

let wwSession = null; // { cookie, at } for this isolate

export function resetGrocerySessions() {
  wwSession = null;
}

export function cleanQuery(q) {
  return String(q || '').replace(/[\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export async function searchGroceries(env, raw) {
  const query = cleanQuery(raw);
  if (query.length < 2) return { error: 'query too short' };
  const [woolworths, coles] = await Promise.all([
    runStore('woolworths', () => searchWoolworths(env, query)),
    runStore('coles', () => searchColes(env, query)),
  ]);
  return {
    query,
    products: mergeProducts([woolworths.products, coles.products]),
    errors: [woolworths.error, coles.error].filter(Boolean),
  };
}

async function runStore(store, fn) {
  try {
    return { products: await fn() };
  } catch (err) {
    console.error('grocery ' + store, err);
    const name = store === 'woolworths' ? 'Woolworths' : 'Coles';
    return { products: [], error: { store, error: name + ' is unavailable right now.' } };
  }
}

async function searchWoolworths(env, query) {
  const key = 'groc:v1:ww:' + encodeURIComponent(query.toLowerCase());
  const hit = await readCache(env, key);
  if (hit) return hit;
  const cookie = await wwCookie(false);
  const first = await wwSearch(query, cookie);
  // A real session cookie that was rejected is worth one fresh bootstrap. A bare Akamai
  // cookie is not a session, and retrying it just doubles the block.
  let found = first.products;
  if (!found && /(?:^|; )(?:w-rctx|wow-auth-token)=/.test(cookie)) found = (await wwSearch(query, await wwCookie(true))).products;
  if (!found) throw new Error('Woolworths blocked the search' + (first.status ? ' (HTTP ' + first.status + ')' : ''));
  await writeCache(env, key, found);
  return found;
}

async function searchColes(env, query) {
  const storeId = String(env.COLES_STORE_ID || '0584');
  const key = 'groc:v1:coles:' + storeId + ':' + encodeURIComponent(query.toLowerCase());
  const hit = await readCache(env, key);
  if (hit) return hit;
  const url = new URL(COLES + '/api/bff/products/search');
  url.searchParams.set('storeId', storeId);
  url.searchParams.set('searchTerm', query);
  url.searchParams.set('start', '0');
  url.searchParams.set('sortBy', 'relevance');
  url.searchParams.set('excludeAds', 'true');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_MS),
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en-AU,en;q=0.9',
      'User-Agent': UA,
      Origin: COLES,
      Referer: COLES + '/search?q=' + encodeURIComponent(query),
      'ocp-apim-subscription-key': env.COLES_SUBSCRIPTION_KEY || COLES_KEY,
    },
  });
  const data = await readJson(res);
  if (!res.ok || !data || !Array.isArray(data.results)) {
    throw new Error(!res.ok ? 'Coles search failed (HTTP ' + res.status + ')' : 'Coles blocked the search');
  }
  const products = normalizeColes(data).slice(0, PER_STORE);
  await writeCache(env, key, products);
  return products;
}

function wwBody(query) {
  return {
    Filters: [],
    IsSpecial: false,
    Location: '/shop/search/products?searchTerm=' + encodeURIComponent(query),
    PageNumber: 1,
    PageSize: 24,
    SearchTerm: query,
    SortType: 'TraderRelevance',
    IsHideEverydayMarketProducts: false,
    ExcludeSearchTypes: ['UntraceableVendors'],
    GroupEdmVariants: false,
    EnableAdReRanking: false,
  };
}

async function wwSearch(query, cookie) {
  const res = await fetch(WW + '/apis/ui/Search/products', {
    method: 'POST',
    signal: AbortSignal.timeout(FETCH_MS),
    headers: wwHeaders(cookie, true),
    body: JSON.stringify(wwBody(query)),
  });
  const data = await readJson(res);
  if (!res.ok || !data || (!Array.isArray(data.Products) && !Array.isArray(data.products))) return { products: null, status: res.status };
  return { products: normalizeWoolworths(data).slice(0, PER_STORE), status: res.status };
}

async function wwCookie(force) {
  if (!force && wwSession && wwSession.cookie && Date.now() - wwSession.at < 20 * 60 * 1000) return wwSession.cookie;
  const jar = new Map();
  const boot = await fetch(WW + '/api/ui/v2/bootstrap', { signal: AbortSignal.timeout(FETCH_MS), headers: wwHeaders('', false) });
  absorbCookies(boot, jar);
  await readJson(boot);
  if (jar.size === 0) {
    const home = await fetch(WW + '/', { signal: AbortSignal.timeout(FETCH_MS), headers: { ...wwHeaders('', false), Accept: 'text/html' } });
    absorbCookies(home, jar);
    await home.arrayBuffer().catch(() => {});
  }
  const cookie = [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
  wwSession = cookie ? { cookie, at: Date.now() } : null;
  return cookie;
}

function wwHeaders(cookie, json) {
  return {
    Accept: json ? 'application/json, text/plain, */*' : 'application/json, text/html',
    'Accept-Language': 'en-AU,en;q=0.9',
    'User-Agent': UA,
    Origin: WW,
    Referer: WW + '/',
    ...(cookie ? { Cookie: cookie } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function absorbCookies(res, jar) {
  const listed = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of listed) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function readJson(res) {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) {
    await res.arrayBuffer().catch(() => {});
    return null;
  }
  return res.json().catch(() => null);
}

function amount(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : null;
}

function https(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function rank(products) {
  const seen = new Set();
  const unique = products.filter((p) => {
    const k = p.store + ':' + p.id;
    if (!p.id || !p.name || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.filter((p) => p.available).concat(unique.filter((p) => !p.available));
}

export function normalizeWoolworths(body) {
  const tiles = Array.isArray(body?.Products) ? body.Products : (Array.isArray(body?.products) ? body.products : []);
  const raw = [];
  for (const tile of tiles) {
    if (!tile || typeof tile !== 'object') continue;
    const nested = Array.isArray(tile.Products) ? tile.Products : (Array.isArray(tile.products) ? tile.products : null);
    if (nested) raw.push(...nested);
    else raw.push(tile);
  }
  return rank(raw.map((p) => {
    const id = String(p.Stockcode || p.StockCode || p.stockcode || '');
    const name = String(p.DisplayName || p.Name || p.name || '').trim();
    const price = amount(p.Price ?? p.InstorePrice);
    const slug = String(p.UrlFriendlyName || '');
    const slugOk = /^[a-z0-9-]+$/i.test(slug);
    return {
      store: 'woolworths',
      storeName: 'Woolworths',
      id,
      name,
      brand: String(p.Brand || p.brand || '').trim(),
      size: String(p.PackageSize || p.packageSize || '').trim(),
      price,
      priceLabel: price != null ? money(price) : '',
      unitPrice: String(p.CupString || '').trim(),
      image: [p.SmallImageFile, p.MediumImageFile].map(https).find(Boolean) || '',
      url: id ? WW + '/shop/productdetails/' + id + (slugOk ? '/' + slug : '') : '',
      available: p.IsInStock !== false && p.IsAvailable !== false,
    };
  }));
}

export function normalizeColes(body) {
  const rows = Array.isArray(body?.results) ? body.results : [];
  return rank(rows.map((p) => {
    if (!p || p._type !== 'PRODUCT') return null;
    const price = amount(p.pricing?.now);
    return {
      store: 'coles',
      storeName: 'Coles',
      id: String(p.id || ''),
      name: String(p.name || '').trim(),
      brand: String(p.brand || '').trim(),
      size: String(p.size || p.packageSize || '').trim(),
      price,
      priceLabel: price != null ? money(price) : '',
      unitPrice: String(p.pricing?.comparable || '').trim(),
      image: colesImage((p.imageUris || []).map((u) => u && u.uri).find(Boolean) || ''),
      url: p.id ? COLES + '/product/' + encodeURIComponent(p.id) : '',
      available: p.availability !== false,
    };
  }).filter(Boolean));
}

function colesImage(uri) {
  if (!uri) return '';
  if (uri.startsWith('https://')) return uri;
  if (uri.startsWith('//')) return https('https:' + uri);
  const path = uri.startsWith('/') ? uri : '/' + uri;
  return 'https://cdn.productimages.coles.com.au/productimages' + path;
}

async function readCache(env, key) {
  if (!env.CALENDAR) return null;
  try {
    const hit = await env.CALENDAR.get(key, 'json');
    return Array.isArray(hit) ? hit : null;
  } catch {
    return null;
  }
}

async function writeCache(env, key, products) {
  if (!env.CALENDAR) return;
  try {
    await env.CALENDAR.put(key, JSON.stringify(products), { expirationTtl: CACHE_S });
  } catch (err) {
    console.error('grocery cache', err);
  }
}
