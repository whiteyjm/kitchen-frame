// Sample Coles rows for Demo mode, so the picker can be shown without calling the shop.
const row = (id, name, brand, size, price, unitPrice) => ({
  store: 'coles',
  storeName: 'Coles',
  id,
  name,
  brand,
  size,
  price,
  priceLabel: '$' + price.toFixed(2),
  unitPrice,
  image: '',
  url: 'https://www.coles.com.au/product/' + id,
  available: true,
});

const DEMO = [
  row('demo-c-milk', 'Full Cream Milk', 'Coles', '2L', 3.4, '$1.70 / 1L'),
  row('demo-c-oat', 'Barista Oat Milk', 'So Good', '1L', 3, '$3.00 / 1L'),
  row('demo-c-chicken', 'Chicken Thighs', '', '1kg', 11, '$11.00 / 1kg'),
  row('demo-c-eggs', 'Free Range Eggs', 'Coles', '12 pack', 6.5, '$1.08 / 100g'),
  row('demo-c-yoghurt', 'Greek Yogurt', 'Chobani', '907g', 7.5, '$0.83 / 100g'),
];

export function demoSearch(query) {
  const words = String(query || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').split(/\s+/).filter(Boolean);
  const products = DEMO.filter((p) => {
    const hay = (p.brand + ' ' + p.name + ' ' + p.size).toLowerCase();
    return words.every((word) => hay.includes(word));
  });
  return { query, products, errors: [] };
}
