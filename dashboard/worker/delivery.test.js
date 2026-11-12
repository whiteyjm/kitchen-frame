import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { colesProductUrl } from '../shared/product.js';
import { sanitizeItems, subtotal, BASKET_KEY, ORDER_KEY } from './delivery.js';

const milk = {
  id: '8150288', store: 'coles', name: 'Full Cream Milk', brand: 'Coles', size: '3L', price: 3.4, quantity: 2,
  image: 'https://cdn.productimages.coles.com.au/productimages/8/8150288.jpg',
};

function memoryKv() {
  const stored = new Map();
  return {
    stored,
    get: async (k, type) => {
      if (!stored.has(k)) return null;
      return type === 'json' ? JSON.parse(stored.get(k)) : stored.get(k);
    },
    put: async (k, v) => { stored.set(k, v); },
  };
}

function call(path, env, init = {}) {
  return worker.fetch(new Request('https://frame.test' + path, {
    ...init,
    headers: { Authorization: 'Bearer k', ...(init.headers || {}) },
  }), env, { waitUntil() {} });
}

test('coles product urls are slug then catalogue id', () => {
  assert.equal(colesProductUrl(milk), 'https://www.coles.com.au/product/coles-full-cream-milk-3l-8150288');
  assert.equal(
    colesProductUrl({ id: 439693, brand: 'Coles', name: 'Coles Full Cream Milk', size: '2L' }),
    'https://www.coles.com.au/product/coles-full-cream-milk-2l-439693',
  );
  assert.equal(colesProductUrl({ id: 9, name: 'Bananas', size: 'per kg' }), 'https://www.coles.com.au/product/bananas-per-kg-9');
  assert.equal(colesProductUrl({ id: 'demo-c-milk', name: 'Full Cream Milk' }), '');
});

test('basket rows keep coles products, merge quantities, and drop the rest', () => {
  const items = sanitizeItems([
    milk,
    { ...milk, quantity: 3, image: 'http://evil.test/a.jpg' },
    { id: '888', store: 'woolworths', name: 'Pura Milk', price: 4.5, quantity: 1 },
    { id: 'nope', name: 'Typed line', quantity: 1 },
    { id: '5', name: '   ', price: 1 },
    { id: '5', name: 'Free Range Eggs', brand: 'Coles', size: '12 pack', price: 0, quantity: 0, image: 'javascript:alert(1)' },
  ]);
  assert.deepEqual(items.map((item) => [item.id, item.quantity, item.price, item.image]), [
    ['8150288', 5, 3.4, milk.image],
    ['5', 1, null, ''],
  ]);
  assert.equal(items[0].url, 'https://www.coles.com.au/product/coles-full-cream-milk-3l-8150288');
  assert.equal(subtotal(items), 17);
  assert.equal(sanitizeItems(Array.from({ length: 70 }, (_, i) => ({ id: String(1000 + i), name: 'Item ' + i, price: 1, quantity: 1 }))).length, 60);
});

test('delivery basket and pending order need the dashboard key and round-trip in KV', async () => {
  const kv = memoryKv();
  const env = { DASHBOARD_KEY: 'k', CALENDAR: kv, COLES_STORE_ID: '4513' };
  assert.equal((await worker.fetch(new Request('https://frame.test/api/delivery/basket'), env, {})).status, 401);
  assert.equal((await worker.fetch(new Request('https://frame.test/api/delivery/pending', { headers: { Authorization: 'Bearer agent' } }), { ...env, AGENT_TOKEN: 'agent' }, {})).status, 401);
  assert.equal((await worker.fetch(new Request('https://frame.test/api/delivery/basket', { headers: { Authorization: 'Bearer k' } }), { DASHBOARD_KEY: 'k' }, {})).status, 503);

  const empty = await (await call('/api/delivery/basket', env)).json();
  assert.deepEqual(empty, { items: [], subtotal: 0, updated: null, storeId: '4513' });
  assert.equal((await call('/api/delivery/basket', env, { method: 'PUT', body: '{}' })).status, 400);
  assert.equal((await call('/api/delivery/submit', env, { method: 'POST' })).status, 400);

  const saved = await (await call('/api/delivery/basket', env, {
    method: 'PUT',
    body: JSON.stringify({ items: [milk, { id: '888', store: 'woolworths', name: 'Pura', price: 4, quantity: 1 }] }),
  })).json();
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].url, 'https://www.coles.com.au/product/coles-full-cream-milk-3l-8150288');
  assert.equal(saved.items[0].quantity, 2);
  assert.equal(saved.subtotal, 6.8);
  assert.equal(saved.storeId, '4513');
  assert.ok(saved.updated);
  assert.equal(JSON.parse(kv.stored.get(BASKET_KEY)).items[0].id, '8150288');

  const pendingBefore = await (await call('/api/delivery/pending', env)).json();
  assert.equal(pendingBefore.status, null);
  assert.equal((await call('/api/delivery/status', env, { method: 'POST', body: JSON.stringify({ status: 'done' }) })).status, 404);
  assert.equal((await call('/api/delivery/status', env, { method: 'POST', body: JSON.stringify({ status: 'paid' }) })).status, 400);

  const order = await (await call('/api/delivery/submit', env, { method: 'POST' })).json();
  assert.equal(order.status, 'pending');
  assert.equal(order.storeId, '4513');
  assert.equal(order.items[0].url, 'https://www.coles.com.au/product/coles-full-cream-milk-3l-8150288');
  assert.equal(order.subtotal, 6.8);
  assert.ok(order.created);
  const storedOrder = JSON.parse(kv.stored.get(ORDER_KEY));
  assert.equal(storedOrder.status, 'pending');
  assert.equal(storedOrder.items[0].id, '8150288');

  // Replacing the basket does not change the order an assistant is already reading.
  await call('/api/delivery/basket', env, { method: 'PUT', body: JSON.stringify({ items: [] }) });
  const still = await (await call('/api/delivery/pending', env)).json();
  assert.equal(still.items.length, 1);
  assert.equal(still.created, order.created);

  const filled = await (await call('/api/delivery/status', env, { method: 'POST', body: JSON.stringify({ status: 'filled-in-cart' }) })).json();
  assert.equal(filled.status, 'filled-in-cart');
  assert.equal(filled.created, order.created);
  assert.ok(filled.updated);
  assert.equal((await (await call('/api/delivery/pending', env)).json()).status, 'filled-in-cart');

  const done = await (await call('/api/delivery/status', env, { method: 'POST', body: JSON.stringify({ status: 'done' }) })).json();
  assert.equal(done.status, 'done');
  assert.equal(done.items[0].url, order.items[0].url);
  assert.equal((await call('/api/delivery/nope', env)).status, 404);
});
