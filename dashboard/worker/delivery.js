// Coles delivery basket for the frame. The frame never logs in, checks out or pays: it keeps a
// list of Coles products in KV and, on Send, snapshots that list for an assistant to add to the
// real Coles cart in a browser. Prices are whatever COLES_STORE_ID's online catalogue returned.
import { colesProductUrl } from '../shared/product.js';

export const BASKET_KEY = 'delivery:basket';
export const ORDER_KEY = 'delivery:order:pending';
const MAX_ITEMS = 60;
const STATUSES = new Set(['pending', 'filled-in-cart', 'done']);

export function subtotal(items) {
  const sum = (items || []).reduce((n, item) => n + (item.price == null ? 0 : item.price * item.quantity), 0);
  return Math.round(sum * 100) / 100;
}

function text(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function priceOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(n, 9999) * 100) / 100;
}

function quantityOf(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(99, n);
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href.slice(0, 500) : '';
  } catch {
    return '';
  }
}

// Keeps Coles rows only, clamps quantities, and rebuilds the product URL from the catalogue id.
export function sanitizeItems(raw) {
  const byId = new Map();
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!row || typeof row !== 'object') continue;
    if (row.store != null && row.store !== '' && row.store !== 'coles') continue;
    const id = text(row.id, 16);
    const name = text(row.name, 200);
    if (!/^[0-9]+$/.test(id) || !name) continue;
    const item = {
      id,
      name,
      brand: text(row.brand, 80),
      size: text(row.size, 80),
      price: priceOf(row.price),
      image: httpsUrl(row.image),
      quantity: quantityOf(row.quantity),
    };
    item.url = colesProductUrl(item);
    const prev = byId.get(id);
    if (prev) {
      prev.quantity = Math.min(99, prev.quantity + item.quantity);
      if (prev.price == null && item.price != null) prev.price = item.price;
      if (!prev.image && item.image) prev.image = item.image;
    } else if (byId.size < MAX_ITEMS) {
      byId.set(id, item);
    }
  }
  return [...byId.values()];
}

function storeId(env) {
  return String(env.COLES_STORE_ID || '').trim();
}

function presentBasket(stored) {
  const items = sanitizeItems(stored && stored.items);
  return { items, subtotal: subtotal(items), updated: (stored && stored.updated) || null };
}

function withStore(env, body) {
  const id = storeId(env);
  return id ? { ...body, storeId: id } : body;
}

async function readKey(env, key) {
  try {
    return await env.CALENDAR.get(key, 'json');
  } catch {
    return null;
  }
}

export async function readBasket(env) {
  return withStore(env, presentBasket(await readKey(env, BASKET_KEY)));
}

export function presentOrder(stored) {
  if (!stored || typeof stored !== 'object' || !STATUSES.has(stored.status)) {
    return { status: null, created: null, updated: null, items: [], subtotal: 0 };
  }
  const items = sanitizeItems(stored.items);
  return {
    status: stored.status,
    created: stored.created || null,
    updated: stored.updated || stored.created || null,
    items,
    subtotal: subtotal(items),
  };
}

export async function readOrder(env) {
  return withStore(env, presentOrder(await readKey(env, ORDER_KEY)));
}

async function write(env, key, value) {
  await env.CALENDAR.put(key, JSON.stringify(value));
}

const WEBHOOK_MS = 15000;
const NOTIFY_KEY = 'delivery:notify';

// A pasted "Authorization: Bearer …" or "Bearer …" still works. The raw secret is never logged.
export function webhookKey(raw) {
  let key = String(raw || '').trim();
  key = key.replace(/^authorization:\s*/i, '').trim();
  key = key.replace(/^bearer\s+/i, '').trim();
  return key;
}

function webhookHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function timedOut(err) {
  const name = err && err.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

// Tells the frame the assistant webhook is configured, without sending the URL or the key.
async function withNotify(env, body) {
  if (!body || !body.status) return body;
  if (!String(env.ORDER_WEBHOOK_URL || '').trim()) return body;
  let notifyResult = null;
  if (env.CALENDAR) {
    try {
      const rec = await env.CALENDAR.get(NOTIFY_KEY, 'json');
      if (rec && typeof rec.ok === 'boolean') {
        notifyResult = { ok: !!rec.ok, status: Number(rec.status) || 0, at: rec.at || null };
      }
    } catch { /* the flag still says the webhook is configured */ }
  }
  return { ...body, notify: true, ...(notifyResult ? { notifyResult } : {}) };
}

async function rememberNotify(env, outcome) {
  if (!env.CALENDAR) return;
  try { await env.CALENDAR.put(NOTIFY_KEY, JSON.stringify(outcome)); } catch (err) {
    console.error(JSON.stringify({ msg: 'order webhook record', error: err && err.name || 'Error' }));
  }
}

// Posts a short notice after a successful submit. No product lines and no dashboard key.
// Only a 2xx counts. A timeout or 5xx is tried once more. Failures are logged and swallowed.
export async function notifyOrder(env, order) {
  const url = String(env.ORDER_WEBHOOK_URL || '').trim();
  if (!url) return;
  const key = webhookKey(env.ORDER_WEBHOOK_KEY);
  const headers = { 'Content-Type': 'application/json' };
  if (key) {
    headers.Authorization = 'Bearer ' + key;
    headers['X-Webhook-Key'] = key;
  }
  const payload = JSON.stringify({
    event: 'coles-order-submitted',
    orderId: order.id,
    createdAt: order.created,
    itemCount: (order.items || []).length,
  });
  const host = webhookHost(url);
  let outcome = { ok: false, status: 0, at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(WEBHOOK_MS) });
      const ms = Date.now() - started;
      console.log(JSON.stringify({ msg: 'order webhook', host, status: res.status, ms, attempt }));
      outcome = { ok: res.status >= 200 && res.status < 300, status: res.status, at: new Date().toISOString() };
      if (outcome.ok || res.status < 500 || attempt === 1) break;
    } catch (err) {
      const ms = Date.now() - started;
      console.error(JSON.stringify({ msg: 'order webhook', host, status: 0, ms, attempt, error: timedOut(err) ? 'timeout' : 'fetch failed' }));
      outcome = { ok: false, status: 0, at: new Date().toISOString() };
      if (!timedOut(err) || attempt === 1) break;
    }
  }
  await rememberNotify(env, outcome);
}

// Returns { status, body } for a /api/delivery/* request, or null when the path isn't one of them.
export async function handleDelivery(req, env, url, ctx) {
  if (!env.CALENDAR) return { status: 503, body: { error: 'KV unavailable' } };
  const path = url.pathname;

  if (path === '/api/delivery/basket' && req.method === 'GET') {
    return { status: 200, body: await readBasket(env) };
  }

  if (path === '/api/delivery/basket' && req.method === 'PUT') {
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.items)) return { status: 400, body: { error: 'items required' } };
    const basket = {
      items: sanitizeItems(body.items),
      updated: new Date().toISOString(),
    };
    basket.subtotal = subtotal(basket.items);
    await write(env, BASKET_KEY, basket);
    return { status: 200, body: withStore(env, basket) };
  }

  if (path === '/api/delivery/submit' && req.method === 'POST') {
    const basket = await readBasket(env);
    if (!basket.items.length) return { status: 400, body: { error: 'basket is empty' } };
    const now = new Date().toISOString();
    const order = {
      id: crypto.randomUUID(),
      status: 'pending',
      created: now,
      updated: now,
      items: basket.items,
      subtotal: basket.subtotal,
    };
    await write(env, ORDER_KEY, order);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(notifyOrder(env, order));
    return { status: 200, body: await withNotify(env, withStore(env, order)) };
  }

  if (path === '/api/delivery/pending' && req.method === 'GET') {
    return { status: 200, body: await withNotify(env, await readOrder(env)) };
  }

  if (path === '/api/delivery/status' && req.method === 'POST') {
    const body = await req.json().catch(() => null);
    const status = body && text(body.status, 40);
    if (!STATUSES.has(status)) return { status: 400, body: { error: 'status must be pending, filled-in-cart, or done' } };
    const stored = await readKey(env, ORDER_KEY);
    const order = presentOrder(stored);
    if (!order.status) return { status: 404, body: { error: 'no pending order' } };
    const next = { ...order, status, updated: new Date().toISOString() };
    await write(env, ORDER_KEY, next);
    return { status: 200, body: withStore(env, next) };
  }

  return null;
}
