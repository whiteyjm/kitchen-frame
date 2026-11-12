// Shared by the Worker and the frame. A chosen supermarket product is stored as the Todoist
// task title plus a description: the first line is what the frame shows under the item
// (store, price, size, and any "For: …" recipe note); the later lines are the stock code and URL.

export function visibleNote(description) {
  const line = String(description || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > 120 ? line.slice(0, 119) + '…' : line;
}

export function money(n) {
  return '$' + Number(n).toFixed(2);
}

// Shelf label: brand and size are added only when the product name doesn't already contain them.
export function productTitle(product) {
  const name = String(product.name || '').trim();
  const brand = String(product.brand || '').trim();
  const size = String(product.size || '').trim();
  const withBrand = brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? brand + ' ' + name : name;
  const titled = size && !withBrand.toLowerCase().includes(size.toLowerCase()) ? withBrand + ' ' + size : withBrand;
  return titled.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function isProductNote(note) {
  return /^(Woolworths|Coles) · /.test(String(note || ''));
}

// Quantity lives on the Todoist title as a trailing " ×2" (nothing when it's 1) and, when a
// description exists, as a "qty: N" line under the visible note. Sizes like "2L" are not quantities.
export function clampQty(n) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return null;
  if (x < 1) return 1;
  return Math.min(99, x);
}

export function splitQuantity(content) {
  const text = String(content || '').trim();
  const m = text.match(/^(.*\S)\s+[×x]\s*(\d{1,2})$/i);
  if (!m) return { name: text, quantity: 1 };
  return { name: m[1].trim(), quantity: clampQty(m[2]) };
}

export function withQuantity(content, quantity) {
  const name = splitQuantity(content).name;
  const n = clampQty(quantity) || 1;
  return n > 1 ? name + ' ×' + n : name;
}

export function quantityFromDescription(description) {
  const m = String(description || '').match(/^qty:\s*(\d{1,2})\s*$/im);
  return m ? clampQty(m[1]) : 1;
}

// The frame shows `quantity` from the API. A cached title may still carry the suffix.
export function groceryName(item) {
  return splitQuantity(item && item.content).name;
}

// Queries to try against Coles for one grocery line: the title without a ×N suffix or a
// "For:" note, then the same line with sizes and the shop name taken off.
export function colesSearchQueries(raw) {
  let text = String(raw || '');
  text = text.replace(/\([^)]*\)/g, ' ');
  text = text.replace(/\bFor:\s*.*/gi, ' ');
  text = splitQuantity(text).name;
  text = text.replace(/^(?:coles|woolworths)\b[:\s-]*/i, '');
  text = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  const queries = [];
  const push = (q) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (s.length < 2) return;
    if (queries.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    queries.push(s);
  };
  push(text);
  const simple = text
    .replace(/\b\d+(?:[./]\d+)?\s*(?:ml|l|g|kg|mg|pack|packs|pk|pkt|pkts)\b/gi, ' ')
    .replace(/\b(?:coles|woolworths)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  push(simple);
  const words = simple.split(' ').filter((w) => w.length > 2 && !/^\d+$/.test(w));
  if (words.length > 2) push(words.slice(0, 2).join(' '));
  return queries;
}

export function groceryQuantity(item) {
  const given = Number(item && item.quantity);
  if (Number.isFinite(given) && given >= 1) return clampQty(given);
  const fromTitle = splitQuantity(item && item.content).quantity;
  return fromTitle > 1 ? fromTitle : 1;
}

// Keeps the first line (the note the frame shows) and drops any previous qty line.
export function setDescriptionQuantity(description, quantity) {
  const n = clampQty(quantity) || 1;
  const lines = String(description || '').split('\n').filter((line) => !/^qty:\s*\d+\s*$/i.test(line.trim()));
  if (n > 1) {
    const at = lines.findIndex((line) => line.trim());
    lines.splice(at === -1 ? lines.length : at + 1, 0, 'qty: ' + n);
  }
  return lines.join('\n').replace(/^\n+|\n+$/g, '').slice(0, 500);
}

// existing is a previous description or its first line (the only part the frame keeps).
// A "For: …" recipe note is carried onto the new first line so it stays visible.
export function productDescription(product, existing = '') {
  const kept = [];
  let forLine = '';
  for (const line of String(existing || '').split('\n')) {
    const text = line.trim();
    if (!text || /^(store|sku|price|url|qty): /.test(text)) continue;
    const embedded = text.match(/\bFor: .+$/);
    if (/^(Woolworths|Coles) · /.test(text)) {
      if (!forLine && embedded) forLine = embedded[0];
      continue;
    }
    if (/^For: /.test(text)) {
      if (!forLine) forLine = text;
      continue;
    }
    kept.push(text);
  }
  const summary = [product.storeName, product.priceLabel, product.size].filter(Boolean).join(' · ');
  const lines = [
    forLine ? summary + ' · ' + forLine : summary,
    'store: ' + product.store,
    'sku: ' + product.id,
    product.price != null && product.price !== '' ? 'price: ' + Number(product.price).toFixed(2) : '',
    ...kept,
    product.url ? 'url: ' + product.url : '',
  ].filter(Boolean);
  return lines.join('\n').slice(0, 500);
}

// Coles product pages are /product/<slug>-<id> (brand, name and size, then the catalogue id).
// The search API only returns the numeric id, so the slug is built the same way the website does.
export function colesProductUrl(product) {
  const id = String(product?.id ?? '').trim();
  if (!/^[0-9]+$/.test(id)) return '';
  const name = String(product.name || '').replace(/\s+/g, ' ').trim();
  const brand = String(product.brand || '').replace(/\s+/g, ' ').trim();
  const size = String(product.size || '').replace(/\s+/g, ' ').trim();
  const withBrand = brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? brand + ' ' + name : name;
  const titled = size && !withBrand.toLowerCase().includes(size.toLowerCase()) ? withBrand + ' ' + size : withBrand;
  const slug = titled.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  return 'https://www.coles.com.au/product/' + (slug ? slug + '-' + id : id);
}

// Take one row from each store in turn so both shops appear at the top of the picker.
export function mergeProducts(groups, limit = 12) {
  const lists = groups.filter(Array.isArray);
  const out = [];
  const n = lists.reduce((m, list) => Math.max(m, list.length), 0);
  for (let i = 0; i < n && out.length < limit; i++) {
    for (const list of lists) if (list[i] && out.length < limit) out.push(list[i]);
  }
  return out;
}
