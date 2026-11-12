# Coles delivery

The Delivery tab builds a Coles order. Search works like Groceries (the same Coles
picker, Coles rows only). Tapping a product stores it in a basket: catalogue id, name, size,
price, image and quantity. **+** and **−** change the quantity, and the trash button removes a
line. The subtotal is the sum of the priced lines.

Prices are Coles online prices for `COLES_STORE_ID`. On this frame that store is **4513** (Coles
Pialba). The delivery fee is shown at Coles checkout. **Send to Coles** does not log in, check
out, or pay. It snapshots the basket so an assistant can add those products to the real Coles
cart in a browser, then mark the order filled.

**Add grocery list** searches Coles for each Todoist grocery line (up to 30) and adds the top
match, using that line’s quantity (a “ ×2” on the title). Lines with no Coles match are skipped.
Demo mode keeps the basket on the frame and does not call the shop or write KV.

The basket is replaced as a whole on each save. The pending order is a copy: editing the basket
afterwards does not change the order until **Send again**.

## Endpoints

Same dashboard key as the other frame APIs (`Authorization: Bearer <DASHBOARD_KEY>`). The agent
token cannot read or write these.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/delivery/basket` | | Basket, or `{ items: [], subtotal: 0, updated: null }` |
| PUT | `/api/delivery/basket` | `{ "items": [ ... ] }` | Replaces the basket (`delivery:basket` in KV) |
| POST | `/api/delivery/submit` | | Copies the basket to `delivery:order:pending` with `status: "pending"` and a timestamp |
| GET | `/api/delivery/pending` | | That order, or `{ status: null, items: [] }` when there isn’t one |
| POST | `/api/delivery/status` | `{ "status": "pending" \| "filled-in-cart" \| "done" }` | Updates the order status |

`storeId` on the JSON is `COLES_STORE_ID` when it is set. Each item’s `url` is
`https://www.coles.com.au/product/<slug>-<id>` (brand, name and size, then the Coles id).

```sh
curl -H "Authorization: Bearer $DASHBOARD_KEY" \
  https://photo-frame-dashboard.<your-subdomain>.workers.dev/api/delivery/pending

curl -X POST -H "Authorization: Bearer $DASHBOARD_KEY" -H "Content-Type: application/json" \
  -d '{"status":"filled-in-cart"}' \
  https://photo-frame-dashboard.<your-subdomain>.workers.dev/api/delivery/status
```

An assistant reads the pending order, opens each product URL, adds the quantity to the Coles
cart, then POSTs `filled-in-cart`. `done` is for when the household has finished with that order.
The next **Send to Coles** replaces the pending order.
