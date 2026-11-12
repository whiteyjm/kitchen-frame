// Proxies Coles catalogue GETs from Joshua's laptop, where Imperva still answers.
// Node 18+. No dependencies. The tunnel URL is posted to the Worker with RELAY_KEY.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLES = 'https://www.coles.com.au';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEARTBEAT_MS = 5 * 60 * 1000;
// Public website key, the same one the Coles page ships. Not a household secret.
const COLES_KEY = 'eae83861d1cd4de6bb9cd8a2cd6f041e';

export function allowedPath(pathname) {
  if (pathname === '/api/bff/products/search') return true;
  if (pathname === '/search/products') return true;
  if (pathname.startsWith('/_next/data/') && !pathname.includes('..')) return true;
  return false;
}

export function tunnelFromLog(text) {
  const match = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : '';
}

export function loadEnvFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const name = trimmed.slice(0, eq).trim();
    if (process.env[name]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[name] = value;
  }
}

function authorized(header, key) {
  const expect = Buffer.from('Bearer ' + key);
  const got = Buffer.from(String(header || ''));
  if (expect.length !== got.length) return false;
  return timingSafeEqual(expect, got);
}

function browserHeaders(target, jar) {
  const json = target.pathname.startsWith('/api/') || target.pathname.includes('.json');
  const headers = {
    Accept: json ? 'application/json' : 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-AU,en;q=0.9',
    'User-Agent': UA,
    Origin: COLES,
    Referer: COLES + '/',
  };
  if (json) headers['ocp-apim-subscription-key'] = COLES_KEY;
  if (jar.size) headers.Cookie = [...jar.entries()].map(([name, value]) => name + '=' + value).join('; ');
  return headers;
}

function rememberCookies(res, jar) {
  const listed = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of listed) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

// fetchImpl is injectable for tests. jar is the Imperva cookie jar for this process.
export function createHandler({ key, fetchImpl = fetch, jar = new Map() }) {
  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(404); res.end(); return;
    }
    if (!key || !authorized(req.headers.authorization || req.headers.Authorization, key)) {
      res.writeHead(401); res.end(); return;
    }
    const incoming = new URL(req.url, 'http://127.0.0.1');
    if (!allowedPath(incoming.pathname)) {
      res.writeHead(404); res.end(); return;
    }
    const target = new URL(incoming.pathname + incoming.search, COLES);
    try {
      const upstream = await fetchImpl(target, { headers: browserHeaders(target, jar), redirect: 'manual' });
      rememberCookies(upstream, jar);
      const body = Buffer.from(await upstream.arrayBuffer());
      const type = upstream.headers.get('content-type') || 'application/octet-stream';
      res.writeHead(upstream.status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      console.error('relay coles', err && err.message || err);
      res.writeHead(502); res.end();
    }
  };
}

export function startRelay({ port = 0, key, fetchImpl }) {
  const jar = new Map();
  const server = http.createServer(createHandler({ key, fetchImpl, jar }));
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, jar }));
  });
}

function cloudflaredBin() {
  const local = path.join(HERE, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  return fs.existsSync(local) ? local : 'cloudflared';
}

let currentUrl = '';
let tunnel;

function startTunnel(port) {
  const bin = cloudflaredBin();
  tunnel = spawn(bin, ['tunnel', '--url', 'http://127.0.0.1:' + port, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const watch = (chunk) => {
    const found = tunnelFromLog(chunk.toString());
    if (found && found !== currentUrl) {
      currentUrl = found;
      console.log('tunnel ' + currentUrl);
      register().catch((err) => console.error('relay register', err && err.message || err));
    }
  };
  tunnel.stdout.on('data', watch);
  tunnel.stderr.on('data', watch);
  tunnel.on('exit', () => {
    console.error('cloudflared exited; restarting');
    setTimeout(() => startTunnel(port), 3000);
  });
}

async function register() {
  const worker = String(process.env.WORKER_URL || '').replace(/\/$/, '');
  if (!worker || !currentUrl) return;
  const res = await fetch(worker + '/api/relay/register', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RELAY_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: currentUrl }),
  });
  if (!res.ok) throw new Error('register HTTP ' + res.status);
}

async function main() {
  loadEnvFile(path.join(HERE, '.env'));
  const key = process.env.RELAY_KEY || '';
  if (!key) {
    console.error('Set RELAY_KEY in relay/.env (relay/install.ps1 writes one).');
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 8787;
  const { server, jar } = await startRelay({ port, key });
  const listening = server.address().port;
  console.log('relay listening on ' + listening);
  // One homepage fetch seeds Imperva cookies before the first catalogue call.
  try {
    const home = await fetch(COLES + '/', { headers: browserHeaders(new URL(COLES + '/'), jar) });
    rememberCookies(home, jar);
    await home.arrayBuffer().catch(() => {});
  } catch { /* the first real search will try again */ }
  startTunnel(listening);
  setInterval(() => { register().catch((err) => console.error('relay register', err && err.message || err)); }, HEARTBEAT_MS);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
