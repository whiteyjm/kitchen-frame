import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWoolworths, normalizeColes, searchGroceries, resetGrocerySessions, cleanQuery } from './groceries.js';
import { productTitle, productDescription, isProductNote, mergeProducts } from '../shared/product.js';

const colesMilk = {
  _type: 'PRODUCT', id: 439693, name: 'Full Cream Milk', brand: 'Coles', size: '2L', availability: true,
  pricing: { now: 3.4, comparable: '$1.70 / 1L' }, imageUris: [{ uri: '/4/439693.jpg' }],
};

test('woolworths tiles flatten, drop rows without a stock code, and put in-stock first', () => {
  const products = normalizeWoolworths({
    Products: [{ Products: [
      { Stockcode: 1, Name: 'Gone', Price: 2, IsInStock: false },
      { Stockcode: 888, DisplayName: 'Pura Milk 2L', Brand: 'Pura', PackageSize: '2L', Price: 4.5, CupString: '$2.25 / 1L', SmallImageFile: 'http://evil.test/a.jpg', MediumImageFile: 'https://cdn0.woolworths.media/content/wowproductimages/medium/888.jpg', UrlFriendlyName: 'pura-milk', IsInStock: true },
      { Name: 'No code', Price: 1 },
    ] }],
  });
  assert.deepEqual(products.map((p) => [p.id, p.available]), [['888', true], ['1', false]]);
  assert.equal(products[0].priceLabel, '$4.50');
  assert.equal(products[0].image, 'https://cdn0.woolworths.media/content/wowproductimages/medium/888.jpg');
  assert.equal(products[0].url, 'https://www.woolworths.com.au/shop/productdetails/888/pura-milk');
  assert.equal(productTitle(products[0]), 'Pura Milk 2L');
});

test('coles rows skip ads and build a small image url', () => {
  const products = normalizeColes({ results: [{ _type: 'SINGLE_TILE', id: 9, name: 'Ad' }, colesMilk, { _type: 'PRODUCT', id: 5, name: 'No price', brand: 'X', size: '1L', pricing: { now: 0 }, imageUris: [] }] });
  assert.equal(products.length, 2);
  assert.equal(products[0].storeName, 'Coles');
  assert.equal(products[0].priceLabel, '$3.40');
  assert.equal(products[0].unitPrice, '$1.70 / 1L');
  assert.equal(products[0].image, 'https://cdn.productimages.coles.com.au/productimages/4/439693.jpg');
  assert.equal(products[0].url, 'https://www.coles.com.au/product/439693');
  assert.equal(products[1].price, null);
  assert.equal(productTitle(products[0]), 'Coles Full Cream Milk 2L');
});

test('a product note keeps a recipe For-line and replaces an older shop line', () => {
  const coles = { store: 'coles', storeName: 'Coles', id: '439693', price: 3.4, priceLabel: '$3.40', size: '2L', url: 'https://www.coles.com.au/product/439693' };
  const text = productDescription(coles, 'For: Fried Rice');
  assert.equal(text.split('\n')[0], 'Coles · $3.40 · 2L · For: Fried Rice');
  assert.deepEqual(text.split('\n').slice(1), ['store: coles', 'sku: 439693', 'price: 3.40', 'url: https://www.coles.com.au/product/439693']);
  assert.equal(isProductNote(text.split('\n')[0]), true);
  const again = productDescription({ ...coles, store: 'woolworths', storeName: 'Woolworths', id: '888', price: 4.5, priceLabel: '$4.50', url: 'https://www.woolworths.com.au/shop/productdetails/888' }, text);
  assert.equal(again.split('\n')[0], 'Woolworths · $4.50 · 2L · For: Fried Rice');
  assert.equal(again.includes('store: coles'), false);
  assert.equal(again.includes('sku: 888'), true);
});

test('stores are interleaved and a blocked shop does not hide the other', async () => {
  assert.deepEqual(mergeProducts([[{ id: 'a' }, { id: 'c' }], [{ id: 'b' }]], 12).map((p) => p.id), ['a', 'b', 'c']);
  assert.equal(cleanQuery('  2L   milk \n'), '2L milk');

  resetGrocerySessions();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('woolworths.com.au')) return new Response('<html>denied</html>', { status: 403, headers: { 'content-type': 'text/html' } });
    if (u.includes('coles.com.au')) return Response.json({ results: [colesMilk] });
    return new Response('no', { status: 404, headers: { 'content-type': 'text/plain' } });
  };
  const blocked = await searchGroceries({}, 'milk');
  assert.equal(blocked.products.length, 1);
  assert.equal(blocked.products[0].store, 'coles');
  assert.deepEqual(blocked.errors, [{ store: 'woolworths', error: 'Woolworths is unavailable right now.' }]);
  assert.equal((await searchGroceries({}, 'x')).error, 'query too short');

  resetGrocerySessions();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('coles.com.au')) return new Response('<html>incapsula</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.includes('woolworths.com.au') && init.method === 'POST') return Response.json({ Products: [] });
    return Response.json({});
  };
  const html = await searchGroceries({}, 'bread');
  assert.deepEqual(html.products, []);
  assert.deepEqual(html.errors, [{ store: 'coles', error: 'Coles is unavailable right now.' }]);
});

test('a coles result is cached in KV for 10 minutes', async () => {
  resetGrocerySessions();
  let hits = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('woolworths.com.au') && init.method === 'POST') return Response.json({ Products: [] });
    if (u.includes('woolworths.com.au')) return Response.json({});
    hits++;
    return Response.json({ results: [colesMilk] });
  };
  const stored = new Map();
  const puts = [];
  const env = {
    COLES_STORE_ID: '4166',
    CALENDAR: {
      get: async (k, type) => {
        const v = stored.get(k);
        if (v == null) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      put: async (k, v, opts) => { stored.set(k, v); puts.push([k, opts]); },
    },
  };
  const first = await searchGroceries(env, 'Milk');
  const second = await searchGroceries(env, 'milk');
  assert.equal(hits, 1);
  assert.equal(first.products[0].id, '439693');
  assert.deepEqual(second.products, first.products);
  const colesPut = puts.find((p) => p[0].includes('groc:v1:coles:4166:'));
  assert.equal(colesPut[1].expirationTtl, 600);
});
