import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedPath, tunnelFromLog, startRelay } from './server.js';

const realFetch = globalThis.fetch;

test('only the Coles catalogue paths are proxied', () => {
  assert.equal(allowedPath('/api/bff/products/search'), true);
  assert.equal(allowedPath('/search/products'), true);
  assert.equal(allowedPath('/_next/data/abc/search/products.json'), true);
  assert.equal(allowedPath('/_next/data/../etc/passwd'), false);
  assert.equal(allowedPath('/api/bff/products/other'), false);
  assert.equal(allowedPath('/'), false);
  assert.equal(tunnelFromLog('log https://happy-otter.trycloudflare.com done'), 'https://happy-otter.trycloudflare.com');
  assert.equal(tunnelFromLog('no url yet'), '');
});

test('the relay requires its key, refuses other paths, and keeps Imperva cookies', async () => {
  const jarSeen = [];
  const { server, port } = await startRelay({
    key: 'secret',
    fetchImpl: async (url, init = {}) => {
      jarSeen.push(init.headers.Cookie || '');
      assert.equal(new URL(url).hostname, 'www.coles.com.au');
      const res = new Response('ok', { status: 200, headers: { 'Content-Type': 'application/json' } });
      res.headers.getSetCookie = () => ['incap_ses=abc; Path=/'];
      return res;
    },
  });
  try {
    const origin = 'http://127.0.0.1:' + port;
    const get = (path, auth) => realFetch(origin + path, { headers: auth ? { Authorization: auth } : {} });
    assert.equal((await get('/api/bff/products/search?searchTerm=milk')).status, 401);
    assert.equal((await get('/api/bff/products/search?searchTerm=milk', 'Bearer wrong')).status, 401);
    assert.equal((await get('/cart', 'Bearer secret')).status, 404);
    assert.equal((await get('/api/bff/products/search?searchTerm=milk', 'Bearer secret')).status, 200);
    const second = await get('/search/products?q=milk', 'Bearer secret');
    assert.equal(second.status, 200);
    assert.equal(jarSeen[0], '');
    assert.equal(jarSeen[1], 'incap_ses=abc');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a thrown Coles fetch is retried once, and a challenge becomes 503', async () => {
  let catalogue = 0;
  const { server, port } = await startRelay({
    key: 'secret',
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/') {
        const home = new Response('home', { status: 200 });
        home.headers.getSetCookie = () => ['nlbi=1; Path=/'];
        return home;
      }
      catalogue++;
      if (catalogue === 1) {
        const err = new Error('reset');
        err.cause = { code: 'ECONNRESET', message: 'socket hang up' };
        throw err;
      }
      if (catalogue === 2) {
        const res = new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
        res.headers.getSetCookie = () => [];
        return res;
      }
      const res = new Response('Pardon Our Interruption _Incapsula_', { status: 200, headers: { 'Content-Type': 'text/html' } });
      res.headers.getSetCookie = () => [];
      return res;
    },
  });
  try {
    const origin = 'http://127.0.0.1:' + port;
    const first = await realFetch(origin + '/api/bff/products/search?searchTerm=milk', { headers: { Authorization: 'Bearer secret' } });
    assert.equal(first.status, 200);
    assert.equal(await first.text(), 'ok');
    const blocked = await realFetch(origin + '/api/bff/products/search?searchTerm=bread', { headers: { Authorization: 'Bearer secret' } });
    assert.equal(blocked.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
