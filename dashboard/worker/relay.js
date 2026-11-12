// The laptop relay (relay/server.js) registers its quick-tunnel URL here. Coles blocks the
// Worker's own address, so catalogue fetches go through the laptop while it is online.
export const RELAY_KEY_NAME = 'relay:home';
const FRESH_MS = 10 * 60 * 1000;

export function tunnelUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (url.protocol !== 'https:') return '';
    if (!/^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function relayAuthorized(req, env) {
  const key = String(env.RELAY_KEY || '');
  if (!key) return false;
  return req.headers.get('Authorization') === 'Bearer ' + key;
}

export async function saveRelay(env, origin) {
  const record = { url: origin, lastSeen: new Date().toISOString() };
  await env.CALENDAR.put(RELAY_KEY_NAME, JSON.stringify(record));
  return record;
}

async function readRelay(env) {
  if (!env.CALENDAR) return null;
  try {
    const rec = await env.CALENDAR.get(RELAY_KEY_NAME, 'json');
    if (!rec || typeof rec.url !== 'string' || !rec.lastSeen) return null;
    return rec;
  } catch {
    return null;
  }
}

// What the frame is allowed to see: online or not, and when the laptop last checked in.
export async function relayStatus(env) {
  const rec = await readRelay(env);
  if (!rec) return { online: false, lastSeen: null };
  const age = Date.now() - Date.parse(rec.lastSeen);
  return { online: age >= 0 && age < FRESH_MS, lastSeen: rec.lastSeen };
}

// Origin to proxy through, or '' when the laptop has not checked in for 10 minutes.
export async function freshRelay(env) {
  const rec = await readRelay(env);
  if (!rec) return '';
  const age = Date.now() - Date.parse(rec.lastSeen);
  return age >= 0 && age < FRESH_MS ? rec.url : '';
}
