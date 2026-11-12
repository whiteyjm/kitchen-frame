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

// Shown when Coles answers with a block instead of a catalogue. The picker turns this into a Retry button.
export const COLES_RETRY = 'Coles didn’t answer, retry';
const RETRIES = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function searchGroceries(env, raw) {
  const query = cleanQuery(raw);
  if (query.length < 2) return { error: 'query too short' };
  try {
    const found = await searchColes(env, query);
    if (found.blocked) {
      return { query, products: [], unavailable: true, errors: [{ store: 'coles', unavailable: true, error: COLES_RETRY }] };
    }
    return { query, products: found.products, errors: [] };
  } catch (err) {
    console.error('grocery coles', err);
    return { query, products: [], unavailable: true, errors: [{ store: 'coles', unavailable: true, error: COLES_RETRY }] };
  }
}

async function searchColes(env, query) {
  const storeId = String(env.COLES_STORE_ID || '0584');
  const key = 'groc:v2:coles:' + storeId + ':' + encodeURIComponent(query.toLowerCase());
  const hit = await readCache(env, key);
  if (hit) return { products: hit, blocked: false };
  const first = await loadPage(env, query, storeId, 0);
  if (!first.products.length) {
    console.log(JSON.stringify({ msg: 'coles empty', query, storeId, blocked: !!first.blocked, via: first.via || '' }));
    return { products: [], blocked: !!first.blocked };
  }
  let products = first.products;
  const step = nextStart(first);
  if (step) {
    // A failed second page must not throw away the first.
    const more = await loadPage(env, query, storeId, step, { fallback: false });
    if (more.products.length) products = mergeFound(products, more.products);
    else console.log(JSON.stringify({ msg: 'coles page2', query, storeId, start: step, blocked: !!more.blocked }));
  }
  const out = products.slice(0, COLES_RESULTS);
  if (out.length) await writeCache(env, key, out);
  return { products: out, blocked: false };
}

function nextStart(page) {
  if (!page || page.products.length >= COLES_RESULTS) return 0;
  const size = page.pageSize || 0;
  if (!(size > 0 && page.products.length >= size)) return 0;
  // noOfResults 0 means the field was missing. A full page is worth one more request.
  if (page.total > 0 && page.total <= page.products.length) return 0;
  return size;
}

function mergeFound(current, extra) {
  const seen = new Set(current.map((p) => p.id));
  const out = current.slice();
  for (const product of extra) {
    if (!product.id || seen.has(product.id) || out.length >= COLES_RESULTS) continue;
    seen.add(product.id);
    out.push(product);
  }
  return out;
}

// Page 0 retries a block, then the website HTML (and a fresh Next build id). Later pages do not.
async function loadPage(env, query, storeId, start, opts = {}) {
  const fallback = opts.fallback !== false && start === 0;
  let last = { products: [], blocked: true, pageSize: 0, total: 0, via: 'bff' };
  for (let attempt = 0; attempt < (fallback ? RETRIES : 1); attempt++) {
    if (attempt) await sleep(400 * attempt);
    try {
      last = await fetchBff(env, query, storeId, start);
    } catch (err) {
      last = { products: [], blocked: true, pageSize: 0, total: 0, via: 'bff', status: 0 };
      console.log(JSON.stringify({ msg: 'coles bff', query, start, attempt, error: String(err && err.message || err) }));
    }
    console.log(JSON.stringify({
      msg: 'coles bff', query, storeId, start, attempt,
      status: last.status || 0, products: last.products.length, pageSize: last.pageSize, blocked: !!last.blocked,
    }));
    if (last.products.length) return last;
    if (!last.blocked) return last;
  }
  if (!fallback) return last;
  const html = await fetchHtml(env, query);
  console.log(JSON.stringify({ msg: 'coles html', query, products: html.products.length, blocked: !!html.blocked, via: html.via || '' }));
  if (html.products.length || !html.blocked) return html;
  return last;
}

async function fetchBff(env, query, storeId, start) {
  const url = new URL(COLES + '/api/bff/products/search');
  url.searchParams.set('storeId', storeId);
  url.searchParams.set('searchTerm', query);
  url.searchParams.set('start', String(start));
  url.searchParams.set('sortBy', 'relevance');
  url.searchParams.set('excludeAds', 'true');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_MS),
    headers: colesHeaders(env, query, true),
  });
  const data = await readJson(res);
  if (res.status === 403 || res.status === 429 || res.status === 503 || !res.ok || !data || !Array.isArray(data.results)) {
    return { products: [], blocked: true, status: res.status, pageSize: 0, total: 0, via: 'bff' };
  }
  return pageFrom(data, res.status, 'bff');
}

function pageFrom(data, status, via) {
  const products = normalizeColes(data);
  const pageSize = Number(data.pageSize) || 0;
  const total = Number(data.noOfResults) || 0;
  // The BFF uses pageSize 0 and an empty list both for "nothing matched" and for a rejected
  // page. Only the BFF copy is treated as a block; the website HTML confirms a real miss.
  const blocked = via === 'bff' && !products.length && pageSize === 0 && total === 0;
  return { products, blocked, status, pageSize, total, via };
}

async function fetchHtml(env, query) {
  let res;
  try {
    res = await fetch(COLES + '/search/products?q=' + encodeURIComponent(query), {
      signal: AbortSignal.timeout(FETCH_MS),
      headers: { ...colesHeaders(env, query, false), Accept: 'text/html' },
    });
  } catch (err) {
    console.log(JSON.stringify({ msg: 'coles html', query, error: String(err && err.message || err) }));
    return { products: [], blocked: true, pageSize: 0, total: 0, via: 'html' };
  }
  const html = await res.text();
  const embedded = extractSearchResults(html);
  if (res.ok && embedded) return pageFrom(embedded, res.status, 'html');
  const buildId = buildIdFrom(html);
  if (buildId) {
    const viaNext = await fetchNextData(env, query, buildId);
    if (viaNext) return viaNext;
  }
  return { products: [], blocked: true, status: res.status, pageSize: 0, total: 0, via: 'html' };
}

async function fetchNextData(env, query, buildId) {
  const url = COLES + '/_next/data/' + encodeURIComponent(buildId) + '/search/products.json?q=' + encodeURIComponent(query);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: colesHeaders(env, query, true) });
    const data = await readJson(res);
    const found = data && findResults(data);
    console.log(JSON.stringify({ msg: 'coles next', query, buildId, status: res.status, products: found ? normalizeColes(found).length : 0 }));
    if (!res.ok || !found) return null;
    return pageFrom(found, res.status, 'next');
  } catch (err) {
    console.log(JSON.stringify({ msg: 'coles next', query, buildId, error: String(err && err.message || err) }));
    return null;
  }
}

function colesHeaders(env, query, json) {
  return {
    Accept: json ? 'application/json' : 'text/html',
    'Accept-Language': 'en-AU,en;q=0.9',
    'User-Agent': UA,
    Origin: COLES,
    Referer: COLES + '/search?q=' + encodeURIComponent(query),
    'ocp-apim-subscription-key': (env && env.COLES_SUBSCRIPTION_KEY) || COLES_KEY,
  };
}

export function extractSearchResults(html) {
  const text = String(html || '');
  const key = '"searchResults":';
  const at = text.indexOf(key);
  if (at < 0) return null;
  const start = text.indexOf('{', at + key.length);
  if (start < 0) return null;
  let depth = 0, quote = '', esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function buildIdFrom(html) {
  const m = String(html || '').match(/\/_next\/static\/([^/"']+)\/_buildManifest\.js/);
  return m ? m[1] : '';
}

function findResults(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node.results) && (node.pageSize != null || node.noOfResults != null)) return node;
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const hit = findResults(value, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
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
    // An empty list used to be stored for 10 minutes and made the same search stay blank.
    return Array.isArray(hit) && hit.length ? hit : null;
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
