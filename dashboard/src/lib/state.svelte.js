// Shared app state and the pollers that fill it. Each feed polls only while something on screen
// needs it (see start()), one request at a time, and unchanged results don't touch the screen.
import { api, cached, remember, changed, forget, withKey } from './api.js';
import { visibleNote, splitQuantity, clampQty, groceryName } from '../../shared/product.js';
import { dayKey, recipeTitle } from './format.js';
import { demoCalendar, demoList, demoMeta } from './demo.js';
import { ha, announce } from './ha.svelte.js';

const MIN = 60 * 1000;
const QUIET_FROM = 22, QUIET_TO = 7; // quiet hours: messages are shown but not read aloud
const quiet = () => { const h = new Date().getHours(); return h >= QUIET_FROM || h < QUIET_TO; };

// One request per feed at a time: a poll, a wake-up refresh and a tap share the request in flight.
const inflight = new Map();
function single(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}
// Preferred speaker for reading messages aloud until one is picked in Settings; if Home Assistant
// has no such speaker, the first Music Assistant speaker is used instead (see announceTarget).
const DEFAULT_SPEAKER = 'media_player.kitchen_mini';
const pref = (k, d) => { try { return localStorage.getItem('frame-' + k) || d; } catch { return d; } };

// Settings live in localStorage so they survive reboots. ?theme= still works for ADB setup.
export const ui = $state({
  tab: 'home', idle: false, theme: 'light', settingsOpen: false,
  themePref: pref('theme', 'auto'),          // auto | light | dark
  idleMinutes: Number(pref('idle', '5')),    // 0 = never
  nightPhotos: pref('night-photos', 'on') === 'on', // slideshow after sunset (dimmed)
  demo: pref('demo', 'off') === 'on',          // sample data instead of real calendars, lists, photos
  clockColor: pref('clock-color', '#ffffff'),  // clock-screen text colour (dimmed at night)
  announceOn: pref('announce', DEFAULT_SPEAKER), // speaker that reads messages aloud, or 'off'
});
export function setSetting(key, value) {
  if (key === 'themePref') { ui.themePref = value; localStorage.setItem('frame-theme', value); applyTheme(); }
  if (key === 'idleMinutes') { ui.idleMinutes = value; localStorage.setItem('frame-idle', String(value)); rearmIdle(); }
  if (key === 'announceOn') { ui.announceOn = value; localStorage.setItem('frame-announce', value); }
  if (key === 'clockColor') { ui.clockColor = value; localStorage.setItem('frame-clock-color', value); }
  if (key === 'nightPhotos') { ui.nightPhotos = value; localStorage.setItem('frame-night-photos', value ? 'on' : 'off'); }
  if (key === 'demo') {
    ui.demo = value;
    localStorage.setItem('frame-demo', value ? 'on' : 'off');
    lists.groceries.items = lists.todo.items = null; // demo lists are rebuilt fresh each time it's switched on
    forget('calendar', 'photos', 'todo', 'groceries', 'todo-meta', 'groceries-meta'); // real data must redraw
    loadCalendar(); loadList('todo'); loadList('groceries'); loadPhotos();
  }
}
export const clock = $state({ now: new Date() });
// In demo mode nothing real is shown at boot, even briefly, and nothing demo is cached as real.
export const calendar = $state({ data: ui.demo ? demoCalendar(new Date()) : cached('calendar'), offline: false });
export const weather = $state({ data: cached('weather'), error: null });
export const photos = $state({ items: ui.demo ? [] : cached('photos') || [] });
// Recipes saved by agents or from Explore (GET /api/recipes).
export const recipes = $state({ saved: cached('recipes') || null, error: null });
export function loadRecipes() {
  return single('recipes', async () => {
    try {
      const { recipes: list } = await api('/api/recipes');
      if (changed('recipes', list)) recipes.saved = list;
      recipes.error = null;
    } catch (err) { recipes.error = err.message; }
  });
}
export async function saveRecipe(recipe) {
  const res = await api('/api/recipes', { method: 'POST', body: JSON.stringify({ ...recipe, ref: recipe.id }) });
  await loadRecipes();
  return res;
}
export async function removeRecipe(id) {
  recipes.saved = (recipes.saved || []).filter((r) => r.id !== id);
  try { await api('/api/recipes/' + id, { method: 'DELETE' }); } catch {}
  loadRecipes();
}
// Recipe ingredients -> Todoist Grocery List, each noting which recipe it's for.
export async function addToGroceries(recipe, ingredients) {
  const items = ingredients.map((i) => ({ content: i.measure ? i.name + ' (' + i.measure + ')' : i.name, description: 'For: ' + recipeTitle(recipe.title) }));
  const added = ui.demo
    ? items.map((x, n) => ({ id: 'demo-r' + Date.now() + n }))
    : (await api('/api/lists/groceries', { method: 'POST', body: JSON.stringify({ items }) })).items;
  const list = lists.groceries;
  list.items = [...(list.items || []), ...added.map((a, n) => ({ id: a.id, content: items[n].content, note: items[n].description }))];
  if (!ui.demo) remember('groceries', list.items);
  return items.length;
}

// Messages posted by agents (POST /api/messages); shown full-screen until dismissed.
export const messages = $state({ items: [] });
export const lists = $state({
  // sections (Todoist order) and people (assignee id -> name) come with each list.
  groceries: { items: ui.demo ? demoList('groceries', new Date()) : cached('groceries'), error: null, ...(ui.demo ? demoMeta('groceries') : cached('groceries-meta') || { sections: [], people: {} }) },
  todo: { items: ui.demo ? demoList('todo', new Date()) : cached('todo'), error: null, ...(ui.demo ? demoMeta('todo') : cached('todo-meta') || { sections: [], people: {} }) },
});

export function loadCalendar() {
  if (ui.demo) { calendar.data = demoCalendar(new Date()); calendar.offline = false; return Promise.resolve(); }
  return single('calendar', async () => {
    try {
      const data = await api('/api/calendar');
      if (changed('calendar', data)) calendar.data = data;
      calendar.offline = false;
    } catch (err) {
      calendar.offline = true;
    }
  });
}

function loadWeather() {
  return single('weather', async () => {
    try {
      const w = await api('/api/weather');
      if (w.error) throw new Error(w.error);
      if (changed('weather', w)) { weather.data = w; applyTheme(); }
      weather.error = null;
    } catch (err) {
      weather.error = err.message;
    }
  });
}

export function loadPhotos() {
  if (ui.demo) { photos.items = []; return Promise.resolve(); } // demo mode never shows family photos
  return single('photos', async () => {
    try {
      const items = (await api('/api/photos')).photos || [];
      if (changed('photos', items)) photos.items = items;
    } catch {}
  });
}

// The clock screen shows photos by day, and at night only if Settings allows it.
export const photosVisible = () => ui.theme !== 'dark' || ui.nightPhotos;

// Messages arrive over a WebSocket the moment they're posted or dismissed (worker/messages.js).
// A "ping" every 30 s keeps the connection open through routers and proves it's alive; the server
// answers "pong" without waking (WebSocket hibernation). While the socket is down the frame
// reconnects with backoff and polls once a minute, so nothing is missed.
const PING_MS = 30 * 1000;
let socketUp = false;
let retryMs = 1000;
function connectMessages() {
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + withKey('/api/messages/live'));
  let alive = true, beat;
  ws.onopen = () => {
    socketUp = true;
    retryMs = 1000;
    beat = setInterval(() => { if (!alive) return ws.close(); alive = false; ws.send('ping'); }, PING_MS);
  };
  ws.onmessage = (e) => {
    alive = true;
    if (e.data !== 'pong') { try { showMessages(JSON.parse(e.data).messages); } catch {} }
  };
  ws.onclose = () => {
    if (socketUp) loadMessages(); // catch anything sent while it was closing
    socketUp = false;
    clearInterval(beat);
    setTimeout(connectMessages, retryMs);
    retryMs = Math.min(retryMs * 2, 60 * 1000);
  };
}

function loadMessages() {
  return single('messages', async () => {
    try { showMessages((await api('/api/messages')).messages); } catch {}
  });
}

function showMessages(list) {
  // Keep ones dismissed on this frame hidden even if the server copy is a moment behind.
  const items = (list || []).filter((m) => !dismissed.has(m.id));
  if (JSON.stringify(items) !== JSON.stringify(messages.items)) messages.items = items;
  announceNew(items);
}

// Read new messages aloud through Home Assistant, once each (remembered across reloads).
// Not in demo mode, not during quiet hours (10 PM-7 AM), not when a message says speak: false,
// and only while it's fresh (under 10 minutes old) so a late reconnect doesn't read old news.
let announced = null;
function announceNew(items) {
  if (announced === null) {
    const saved = localStorage.getItem('frame-announced');
    // First run of this feature: treat messages already on the frame as announced.
    announced = new Set(saved ? JSON.parse(saved) : items.map((m) => m.id));
    if (!saved) saveAnnounced();
  }
  const target = announceTarget();
  if (ui.demo || !target || ha.status !== 'connected' || quiet()) return;
  for (const m of items) {
    if (announced.has(m.id) || m.speak === false || Date.now() - Date.parse(m.at) > 10 * MIN) continue;
    const text = (m.from ? 'Message from ' + m.from + '. ' : '') + [m.title, m.body].filter(Boolean).join('. ');
    announced.add(m.id); // claim it now so the next poll doesn't repeat it
    announce(text.slice(0, 400), target.entity_id).then(saveAnnounced, () => announced.delete(m.id));
  }
}
// The speaker that reads messages aloud: the chosen one if Home Assistant has it, else the first
// speaker; null when read-aloud is off or there are no speakers.
export function announceTarget() {
  if (ui.announceOn === 'off') return null;
  return ha.players.find((p) => p.entity_id === ui.announceOn) || ha.players[0] || null;
}
function saveAnnounced() {
  try { localStorage.setItem('frame-announced', JSON.stringify([...announced].slice(-100))); } catch {}
}
const dismissed = new Set();
export async function dismissMessage(m) {
  dismissed.add(m.id);
  messages.items = messages.items.filter((x) => x.id !== m.id);
  try { await api('/api/messages/' + m.id + '/dismiss', { method: 'POST' }); } catch {}
}

export function loadList(name) {
  if (ui.demo) {
    // Keep demo edits (ticks, additions) until demo mode is switched off and on again.
    if (!lists[name].items) lists[name].items = demoList(name, new Date());
    Object.assign(lists[name], demoMeta(name));
    lists[name].error = null;
    return Promise.resolve();
  }
  return single('list:' + name, async () => {
    try {
      const { items, sections = [], people = {}, project = '' } = await api('/api/lists/' + name);
      if (changed(name, items)) lists[name].items = items;
      if (changed(name + '-meta', { sections, people, project })) Object.assign(lists[name], { sections, people, project });
      lists[name].error = null;
    } catch (err) {
      lists[name].error = err.message;
    }
  });
}

// Optimistic: the row disappears on tap and comes back if Todoist refuses.
export async function completeItem(name, item) {
  const list = lists[name];
  list.items = list.items.filter((i) => i.id !== item.id);
  if (ui.demo) return; // demo: never touches Todoist
  try {
    await api('/api/lists/' + name + '/' + item.id + '/done', { method: 'POST' });
    remember(name, list.items);
  } catch (err) {
    list.items = [item, ...list.items];
    list.error = 'Couldn’t complete “' + item.content + '”: ' + err.message;
  }
}

export async function addItem(name, content, description) {
  const list = lists[name];
  const note = visibleNote(description);
  if (ui.demo) {
    const parsed = splitQuantity(content);
    list.items = [...(list.items || []), { id: 'demo-' + Date.now(), content: parsed.name, quantity: parsed.quantity, ...(note ? { note } : {}) }];
    return true;
  }
  try {
    const item = await api('/api/lists/' + name, { method: 'POST', body: JSON.stringify({ content, ...(description ? { description } : {}) }) });
    list.items = [...(list.items || []), item];
    remember(name, list.items);
    return true;
  } catch (err) {
    list.error = 'Couldn’t add “' + content + '”: ' + err.message;
    return false;
  }
}

// Point an existing grocery line at a chosen product. Demo mode stays on the device.
export async function updateItem(name, item, content, description) {
  const list = lists[name];
  const note = visibleNote(description);
  const parsed = splitQuantity(content);
  const next = { ...item, content: parsed.name, quantity: parsed.quantity };
  if (note) next.note = note;
  else delete next.note;
  const prev = list.items;
  list.items = (prev || []).map((i) => (i.id === item.id ? next : i));
  if (ui.demo) return true;
  try {
    const saved = await api('/api/lists/' + name + '/' + encodeURIComponent(item.id), {
      method: 'POST',
      body: JSON.stringify({ content, description: description || '' }),
    });
    list.items = list.items.map((i) => (i.id === item.id ? { ...next, ...saved } : i));
    remember(name, list.items);
    return true;
  } catch (err) {
    list.items = prev;
    list.error = 'Couldn’t update “' + item.content + '”: ' + err.message;
    return false;
  }
}

// Groceries only. One stays a bare title; two or more are "Name ×N" in Todoist.
export async function setQuantity(name, item, quantity) {
  const n = clampQty(quantity);
  if (n == null) return false;
  const list = lists[name];
  const prev = list.items;
  const nameOnly = groceryName(item);
  list.items = (prev || []).map((i) => (i.id === item.id ? { ...i, content: nameOnly, quantity: n } : i));
  if (ui.demo) return true;
  try {
    const saved = await api('/api/lists/' + name + '/' + encodeURIComponent(item.id), {
      method: 'POST',
      body: JSON.stringify({ quantity: n }),
    });
    list.items = list.items.map((i) => (i.id === item.id ? { ...i, ...saved } : i));
    remember(name, list.items);
    return true;
  } catch (err) {
    list.items = prev;
    list.error = 'Couldn’t update “' + nameOnly + '”: ' + err.message;
    return false;
  }
}

// Runs fn now (if when() allows) and then every ms (a number, or a function for a varying gap).
// The next run is scheduled after the previous one finishes, so slow requests never stack up.
function every(ms, fn, when = () => true) {
  const run = async () => {
    try { if (when()) await fn(); } catch {}
    setTimeout(run, typeof ms === 'function' ? ms() : ms);
  };
  run();
}

// Light from sunrise to sunset, dark otherwise (7 AM / 7 PM until weather arrives).
// Pin it with ?theme=light or ?theme=dark; ?theme=auto goes back to following the sun.
const themeParam = new URLSearchParams(location.search).get('theme');
if (themeParam) { localStorage.setItem('frame-theme', themeParam); ui.themePref = themeParam; }

function applyTheme() {
  let dark;
  if (ui.themePref === 'light' || ui.themePref === 'dark') {
    dark = ui.themePref === 'dark';
  } else {
    const now = clock.now;
    const today = weather.data && weather.data.days.find((d) => d.date === dayKey(now));
    const at = (h) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h);
    const rise = today && today.sunrise ? new Date(today.sunrise) : at(7);
    const set = today && today.sunset ? new Date(today.sunset) : at(19);
    dark = now < rise || now >= set;
  }
  ui.theme = dark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', ui.theme);
}

export function start() {
  // Clock aligned to the minute boundary.
  (function tick() {
    clock.now = new Date();
    applyTheme();
    setTimeout(tick, MIN - (Date.now() % MIN) + 50);
  })();
  every(5 * MIN, loadCalendar);
  every(15 * MIN, loadWeather);
  // Tasks show on Home and Tasks; Groceries only on its own tab (App loads a list when its tab opens).
  every(MIN, () => loadList('todo'), () => !ui.idle);
  every(MIN, () => loadList('groceries'), () => !ui.idle && ui.tab === 'groceries');
  // Photos: once at start (for the next slide), then while the clock screen is up and showing photos.
  let photosOnce = true;
  every(5 * MIN, () => { photosOnce = false; return loadPhotos(); }, () => photosOnce || (ui.idle && photosVisible()));
  // Messages: pushed over a WebSocket; polled once a minute only while it's down.
  connectMessages();
  every(MIN, loadMessages, () => !socketUp);

  // Idle: no touch for the chosen time -> ambient screen. Any touch wakes it back to Home.
  addEventListener('pointerdown', rearmIdle, { passive: true });
  rearmIdle();
}

let idleTimer;
function rearmIdle() {
  clearTimeout(idleTimer);
  if (!ui.idleMinutes) return;
  idleTimer = setTimeout(() => { ui.idle = true; ui.tab = 'home'; ui.settingsOpen = false; loadPhotos(); }, ui.idleMinutes * MIN);
}

// Play button: show the clock screen / slideshow now.
export function startSlideshow() {
  ui.settingsOpen = false;
  ui.tab = 'home';
  ui.idle = true;
  loadPhotos();
}

export function exitIdle() {
  ui.idle = false;
  loadList('todo');
}
