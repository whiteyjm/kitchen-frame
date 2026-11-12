// Product search for Groceries and Delivery. The frame never talks to Coles itself: this proxy
// normalises a few fields and caches them briefly. Nothing here logs in or checks out.
//
// Coles: public website BFF (the subscription key is the one shipped in coles.com.au, not a
// household secret). Store prices follow COLES_STORE_ID (default 0584). Woolworths is not called.
import { money } from '../shared/product.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WW = 'https://www.woolworths.com.au';
const COLES = 'https://www.coles.com.au';
// Public client key from the Coles website. Override with COLES_SUBSCRIPTION_KEY when it rotates.
const COLES_KEY = 'eae83861d1cd4de6bb9cd8a2cd6f041e';
// The picker used to keep 8 Coles rows. It now keeps 20 more.
export const COLES_RESULTS = 28;
const CACHE_S = 600;
const FETCH_MS = 8000;

export function cleanQuery(q) {
  return String(q || '').replace(/[\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export async function searchGroceries(env, raw) {
  const query = cleanQuery(raw);
  if (query.length < 2) return { error: 'query too short' };
  try {
    return { query, products: await searchColes(env, query), errors: [] };
  } catch (err) {
    console.error('grocery coles', err);
    return { query, products: [], errors: [{ store: 'coles', error: 'Coles is unavailable right now.' }] };
  }
}

async function searchColes(env, query) {
  const storeId = String(env.COLES_STORE_ID || '0584');
  const key = 'groc:v2:coles:' + storeId + ':' + encodeURIComponent(query.toLowerCase());
  const hit = await readCache(env, key);
  if (hit) return hit;
  const products = [];
  const seen = new Set();
  let start = 0;
  // Coles answers one page at a time (pageSize is often 20, and a page can also run long).
  // Keep asking while a full page comes back and we still need rows.
  for (let page = 0; page < 4 && products.length < COLES_RESULTS; page++) {
    let data;
    try {
      data = await fetchColesPage(env, query, storeId, start);
    } catch (err) {
      if (!products.length) throw err;
      break;
    }
    const batch = normalizeColes(data);
    let added = 0;
    for (const product of batch) {
      if (!product.id || seen.has(product.id)) continue;
      seen.add(product.id);
      products.push(product);
      added++;
      if (products.length >= COLES_RESULTS) break;
    }
    if (!added) break;
    const pageSize = Number(data && data.pageSize);
    const step = pageSize > 0 ? pageSize : batch.length;
    if (!step || batch.length < step) break;
    start += step;
  }
  const out = products.slice(0, COLES_RESULTS);
  await writeCache(env, key, out);
  return out;
}

async function fetchColesPage(env, query, storeId, start) {
  const url = new URL(COLES + '/api/bff/products/search');
  url.searchParams.set('storeId', storeId);
  url.searchParams.set('searchTerm', query);
  url.searchParams.set('start', String(start));
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
  return data;
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
