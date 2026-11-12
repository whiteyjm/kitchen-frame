import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWoolworths, normalizeColes, searchGroceries, cleanQuery, COLES_RESULTS } from './groceries.js';
import { productTitle, productDescription, isProductNote, mergeProducts, withQuantity, splitQuantity, setDescriptionQuantity, colesSearchQueries } from '../shared/product.js';

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

test('search asks only Coles, keeps twenty more rows than the old cap, and pages when a page is short', async () => {
  assert.deepEqual(mergeProducts([[{ id: 'a' }, { id: 'c' }], [{ id: 'b' }]], 12).map((p) => p.id), ['a', 'b', 'c']);
  assert.equal(cleanQuery('  2L   milk \n'), '2L milk');
  assert.equal(COLES_RESULTS, 28);
  assert.deepEqual([withQuantity('Milk', 1), withQuantity('Milk ×2', 3), splitQuantity('Coles Milk 2L ×2').name], ['Milk', 'Milk ×3', 'Coles Milk 2L']);
  assert.equal(setDescriptionQuantity('Coles · $3.40\nsku: 1', 2), 'Coles · $3.40\nqty: 2\nsku: 1');
  assert.equal(setDescriptionQuantity('Coles · $3.40\nqty: 2\nsku: 1', 1), 'Coles · $3.40\nsku: 1');
  assert.deepEqual(
    colesSearchQueries('Coles Full Cream Milk 2L ×2 (For: custard)'),
    ['Full Cream Milk 2L', 'Full Cream Milk', 'Full Cream'],
  );
  assert.deepEqual(colesSearchQueries('Eggs ×3'), ['Eggs']);

  const calls = [];
  const page = (start, n, pageSize) => ({
    pageSize,
    results: Array.from({ length: n }, (_, i) => ({
      _type: 'PRODUCT', id: start + i + 1, name: 'Milk ' + (start + i), brand: 'Coles', size: '1L', availability: true,
      pricing: { now: 1 }, imageUris: [],
    })),
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    assert.equal(u.includes('woolworths.com.au'), false);
    const start = Number(new URL(u).searchParams.get('start'));
    if (start === 0) return Response.json(page(0, 20, 20));
    if (start === 20) return Response.json(page(100, 15, 20));
    return Response.json({ pageSize: 0, results: [] });
  };
  const found = await searchGroceries({}, 'milk');
  assert.equal(found.products.length, 28);
  assert.equal(found.products.every((p) => p.store === 'coles'), true);
  assert.deepEqual(calls.map((u) => new URL(u).searchParams.get('start')), ['0', '20']);
  assert.equal((await searchGroceries({}, 'x')).error, 'query too short');

  globalThis.fetch = async (url) => {
    assert.equal(String(url).includes('woolworths.com.au'), false);
    return new Response('<html>incapsula</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const html = await searchGroceries({}, 'bread');
  assert.deepEqual(html.products, []);
  assert.equal(html.unavailable, true);
  assert.equal(html.errors[0].error, 'Coles didn’t answer, retry');
});

test('an empty Coles answer is not cached, and a later good answer is', async () => {
  const stored = new Map();
  const puts = [];
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const u = String(url);
    if (u.includes('/search/products')) {
      return new Response('<html>incapsula</html>', { headers: { 'content-type': 'text/html' } });
    }
    if (calls < 3) return Response.json({ pageSize: 0, noOfResults: 0, results: [] });
    return Response.json({ pageSize: 20, noOfResults: 1, results: [colesMilk] });
  };
  const env = {
    COLES_STORE_ID: '4513',
    CALENDAR: {
      get: async (k, type) => {
        const v = stored.get(k);
        if (v == null) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      put: async (k, v, opts) => { stored.set(k, v); puts.push([k, opts]); },
    },
  };
  const empty = await searchGroceries(env, 'milk');
  assert.equal(empty.products.length, 0);
  assert.equal(empty.unavailable, true);
  assert.equal(puts.length, 0);
  const again = await searchGroceries(env, 'milk');
  assert.equal(again.products.length, 1);
  assert.equal(puts.length, 1);
  assert.equal(puts[0][1].expirationTtl, 600);
});

test('a failed second page still returns the first page', async () => {
  globalThis.fetch = async (url) => {
    const start = Number(new URL(url).searchParams.get('start'));
    if (start === 0) {
      return Response.json({
        pageSize: 20, noOfResults: 40,
        results: Array.from({ length: 20 }, (_, i) => ({ _type: 'PRODUCT', id: i + 1, name: 'Milk ' + i, brand: 'Coles', size: '1L', availability: true, pricing: { now: 2 }, imageUris: [] })),
      });
    }
    return new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  };
  const found = await searchGroceries({}, 'milk');
  assert.equal(found.products.length, 20);
  assert.equal(found.unavailable, undefined);
});

test('the website HTML is used when the BFF comes back empty', async () => {
  const product = { _type: 'PRODUCT', id: 439693, name: 'Full Cream Milk', brand: 'Coles', size: '2L', availability: true, pricing: { now: 3.4 }, imageUris: [] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/bff/')) return Response.json({ pageSize: 0, noOfResults: 0, results: [] });
    if (u.includes('/search/products')) {
      return new Response('<html><script>"searchResults":' + JSON.stringify({ pageSize: 48, noOfResults: 1, results: [product] }) + '</script></html>', { headers: { 'content-type': 'text/html' } });
    }
    return new Response('no', { status: 404 });
  };
  const found = await searchGroceries({}, 'milk');
  assert.equal(found.products[0].id, '439693');
  assert.equal(found.unavailable, undefined);
});

test('a coles result is cached in KV for 10 minutes', async () => {
  let hits = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url).includes('woolworths.com.au'), false);
    hits++;
    return Response.json({ pageSize: 20, results: [colesMilk] });
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
  const colesPut = puts.find((p) => p[0].includes('groc:v2:coles:4166:'));
  assert.equal(colesPut[1].expirationTtl, 600);
});
