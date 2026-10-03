# Checkout & Rewards Service

Zero-dependency Node (>=20) service, in-memory store. Design rationale: see [DECISIONS.md](DECISIONS.md).

```bash
npm start                      # http://localhost:3000   (PORT, COUPON_EVERY_N=5, COUPON_PERCENT=10)
npm test                       # 10 tests, incl. concurrent / retry scenarios
```

Seed products: `tee`, `mug`, `sticker`, `poster`, and `hoodie` (stock 3, the limited-inventory item).
All money is integer cents (`USD`). Errors are always `{"error":{"code","message","details"}}`.

## Endpoints

| Method & path | Success | Notable errors |
|---|---|---|
| `GET /products` | 200 list | |
| `POST /carts` | 201 cart | |
| `GET /carts/:id` | 200 cart (lines, unit price, line totals, `subtotalCents`, `priceChangedSinceAdded`, `inStock`) | 404 `CART_NOT_FOUND` |
| `POST /carts/:id/items` `{productId, quantity}` | 201 cart (adds to existing quantity) | 400 `INVALID_QUANTITY`; 404 `PRODUCT_NOT_FOUND`; 409 `INSUFFICIENT_STOCK`, `CART_NOT_OPEN` |
| `PATCH /carts/:id/items/:productId` `{quantity}` | 200 cart | as above + 404 `ITEM_NOT_IN_CART` |
| `DELETE /carts/:id/items/:productId` | 200 cart | 404 `ITEM_NOT_IN_CART`, 409 `CART_NOT_OPEN` |
| `POST /carts/:id/checkout` **header `Idempotency-Key` required**; body `{couponCode?, expectedSubtotalCents?}` | 201 order (first success); **200 + `Idempotent-Replayed: true`** for a retry | 400 `IDEMPOTENCY_KEY_REQUIRED`; 409 `INSUFFICIENT_STOCK` (details.shortages), `PRICE_CHANGED`, `COUPON_UNAVAILABLE`, `CART_ALREADY_CHECKED_OUT`, `CHECKOUT_IN_PROGRESS`; 422 `EMPTY_CART`, `COUPON_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`; 402 `PAYMENT_FAILED` |
| `GET /orders/:id` | 200 order (line snapshot, subtotal, coupon, discount, total) | 404 `ORDER_NOT_FOUND` |
| **admin** `POST /admin/coupons/generate` | 201 coupon | 409 `NO_ELIGIBLE_MILESTONE` (details: placed orders, next milestone) |
| **admin** `GET /admin/coupons` | 200 list with status `available/reserved/redeemed` | |
| **admin** `GET /admin/report` | 200 summary (read-only) | |

## Example

```bash
CART=$(curl -s -XPOST localhost:3000/carts | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s -XPOST localhost:3000/carts/$CART/items -d '{"productId":"hoodie","quantity":2}'
curl -s -XPOST localhost:3000/carts/$CART/checkout -H 'Idempotency-Key: demo-1' -d '{}'
curl -s -XPOST localhost:3000/carts/$CART/checkout -H 'Idempotency-Key: demo-1' -d '{}'   # replay: same order, 200
curl -s localhost:3000/admin/report
```
