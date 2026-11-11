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

// existing is a previous description or its first line (the only part the frame keeps).
// A "For: …" recipe note is carried onto the new first line so it stays visible.
export function productDescription(product, existing = '') {
  const kept = [];
  let forLine = '';
  for (const line of String(existing || '').split('\n')) {
    const text = line.trim();
    if (!text || /^(store|sku|price|url): /.test(text)) continue;
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
