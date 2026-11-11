// Sample supermarket rows for Demo mode, so the picker can be shown without calling the shops.
import { mergeProducts } from '../../shared/product.js';

const row = (store, id, name, brand, size, price, unitPrice) => ({
  store,
  storeName: store === 'woolworths' ? 'Woolworths' : 'Coles',
  id,
  name,
  brand,
  size,
  price,
  priceLabel: '$' + price.toFixed(2),
  unitPrice,
  image: '',
  url: store === 'woolworths'
    ? 'https://www.woolworths.com.au/shop/productdetails/' + id
    : 'https://www.coles.com.au/product/' + id,
  available: true,
});

const DEMO = [
  row('woolworths', 'demo-ww-milk', 'Full Cream Milk', 'Dairy Farmers', '2L', 4.5, '$2.25 / 1L'),
  row('coles', 'demo-c-milk', 'Full Cream Milk', 'Coles', '2L', 3.4, '$1.70 / 1L'),
  row('woolworths', 'demo-ww-milk3', 'Full Cream Milk', 'Pura', '3L', 5.6, '$1.87 / 1L'),
  row('coles', 'demo-c-oat', 'Barista Oat Milk', 'So Good', '1L', 3, '$3.00 / 1L'),
  row('woolworths', 'demo-ww-chicken', 'Chicken Thighs', '', '1kg', 12, '$12.00 / 1kg'),
  row('coles', 'demo-c-chicken', 'Chicken Thighs', '', '1kg', 11, '$11.00 / 1kg'),
  row('woolworths', 'demo-ww-bread', 'Sourdough', 'Baker\'s Finest', '650g', 4, '$0.62 / 100g'),
  row('coles', 'demo-c-eggs', 'Free Range Eggs', 'Coles', '12 pack', 6.5, '$1.08 / 100g'),
  row('woolworths', 'demo-ww-bananas', 'Bananas', '', 'per kg', 4.5, '$4.50 / 1kg'),
  row('coles', 'demo-c-yoghurt', 'Greek Yogurt', 'Chobani', '907g', 7.5, '$0.83 / 100g'),
];

export function demoSearch(query) {
  const words = String(query || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').split(/\s+/).filter(Boolean);
  const products = DEMO.filter((p) => {
    const hay = (p.brand + ' ' + p.name + ' ' + p.size).toLowerCase();
    return words.every((word) => hay.includes(word));
  });
  const woolworths = products.filter((p) => p.store === 'woolworths');
  const coles = products.filter((p) => p.store === 'coles');
  return { query, products: mergeProducts([woolworths, coles]), errors: [] };
}
