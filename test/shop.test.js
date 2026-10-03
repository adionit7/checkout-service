import test from 'node:test';
import assert from 'node:assert/strict';
import { Shop, ApiError, discountCents } from '../src/shop.js';

const cartWith = (shop, productId, quantity) => {
  const { id } = shop.createCart();
  shop.addItem(id, { productId, quantity });
  return id;
};
const settle = (ps) => Promise.allSettled(ps);
const ok = (rs) => rs.filter((r) => r.status === 'fulfilled');
const failCodes = (rs) => rs.filter((r) => r.status === 'rejected').map((r) => r.reason.code);

// Place n orders so that milestones are reached.
async function placeOrders(shop, count) {
  for (let i = 0; i < count; i++) await shop.checkout(cartWith(shop, 'sticker', 1), `k${i}`);
}

test('concurrent checkouts never oversell limited stock', async () => {
  const shop = new Shop(); // hoodie stock = 3
  const carts = Array.from({ length: 10 }, () => cartWith(shop, 'hoodie', 1)); // all pass add-time check
  const rs = await settle(carts.map((c, i) => shop.checkout(c, `k${i}`)));
  assert.equal(ok(rs).length, 3);
  assert.deepEqual([...new Set(failCodes(rs))], ['INSUFFICIENT_STOCK']);
  assert.equal(shop.products.get('hoodie').stock, 0);
  assert.equal(shop.report().purchasedQuantityByProduct.hoodie, 3);
});

test('retried checkout (same key, concurrent and later) creates one order and takes stock once', async () => {
  const shop = new Shop();
  const cart = cartWith(shop, 'mug', 2);
  const rs = await Promise.all([1, 2, 3].map(() => shop.checkout(cart, 'same-key')));
  const later = await shop.checkout(cart, 'same-key');
  assert.equal(new Set([...rs, later].map((r) => r.order.id)).size, 1);
  assert.equal(rs.filter((r) => !r.replayed).length, 1);
  assert.equal(shop.products.get('mug').stock, 48);
  assert.equal(shop.report().totalOrders, 1);

  // A different key on an already-checked-out cart is rejected, not a second order.
  await assert.rejects(shop.checkout(cart, 'other-key'), { code: 'CART_ALREADY_CHECKED_OUT' });
  // Same key, different body is a client bug.
  await assert.rejects(shop.checkout(cart, 'same-key', { couponCode: 'X' }), { code: 'IDEMPOTENCY_KEY_REUSED' });
});

test('coupon: one per milestone, even under concurrent generation', async () => {
  const shop = new Shop({ n: 3, x: 10 });
  assert.throws(() => shop.generateCoupon(), { code: 'NO_ELIGIBLE_MILESTONE' });
  await placeOrders(shop, 3);
  const rs = await settle(Array.from({ length: 5 }, async () => shop.generateCoupon()));
  assert.equal(ok(rs).length, 1);
  await placeOrders(shop, 2); // 5 orders: still only milestone 1 reached
  assert.throws(() => shop.generateCoupon(), { code: 'NO_ELIGIBLE_MILESTONE' });
  await placeOrders(shop, 1); // 6 orders: milestone 2
  assert.equal(shop.generateCoupon().milestone, 2);
});

test('coupon cannot be redeemed by two concurrent checkouts', async () => {
  const shop = new Shop({ n: 1, x: 10 });
  await placeOrders(shop, 1);
  const { code } = shop.generateCoupon();
  const a = cartWith(shop, 'tee', 1);
  const b = cartWith(shop, 'tee', 1);
  const rs = await settle([shop.checkout(a, 'a', { couponCode: code }), shop.checkout(b, 'b', { couponCode: code })]);
  assert.equal(ok(rs).length, 1);
  assert.deepEqual(failCodes(rs), ['COUPON_UNAVAILABLE']);
  assert.equal(shop.report().coupons.redeemed, 1);
});

test('failed payment releases stock, coupon and cart; retry then succeeds', async () => {
  let fail = true;
  const payments = { charge: async () => ({ ok: !fail }) };
  const shop = new Shop({ n: 1, x: 10, payments });
  fail = false;
  await placeOrders(shop, 1);
  const { code } = shop.generateCoupon();
  const cart = cartWith(shop, 'hoodie', 2);

  fail = true;
  await assert.rejects(shop.checkout(cart, 'k', { couponCode: code }), { code: 'PAYMENT_FAILED' });
  assert.equal(shop.products.get('hoodie').stock, 3);
  assert.equal(shop.coupons.get(code).status, 'available');
  assert.equal(shop.report().totalOrders, 1); // failed order is not counted

  fail = false;
  const { order } = await shop.checkout(cart, 'k', { couponCode: code }); // same key is reusable after failure
  assert.equal(order.discountCents, 1199); // floor(11998 * 10%)
  assert.equal(shop.coupons.get(code).status, 'redeemed');
});

test('money: integer cents, floor rounding, discount never exceeds subtotal', () => {
  assert.equal(discountCents(1999, 10), 199); // 199.9 -> 199
  assert.equal(discountCents(1, 99), 0);
  const shop = new Shop({ n: 1, x: 150 }); // pathological config
  return placeOrders(shop, 1).then(async () => {
    const { code } = shop.generateCoupon();
    const { order } = await shop.checkout(cartWith(shop, 'tee', 1), 'k', { couponCode: code });
    assert.equal(order.totalCents, 0);
    assert.ok(order.totalCents >= 0);
  });
});

test('order snapshot survives product changes; price change is surfaced and guardable', async () => {
  const shop = new Shop();
  const cart = cartWith(shop, 'tee', 2);
  shop.products.get('tee').priceCents = 2500;
  const view = shop.viewCart(cart);
  assert.equal(view.lines[0].priceChangedSinceAdded, true);
  assert.equal(view.subtotalCents, 5000);
  await assert.rejects(shop.checkout(cart, 'k1', { expectedSubtotalCents: 3998 }), { code: 'PRICE_CHANGED' });
  assert.equal(shop.products.get('tee').stock, 100); // rejected checkout touched nothing

  const { order } = await shop.checkout(cart, 'k2', { expectedSubtotalCents: 5000 });
  shop.products.get('tee').priceCents = 1;
  const stored = shop.getOrder(order.id);
  assert.equal(stored.lines[0].unitPriceCents, 2500);
  assert.equal(stored.totalCents, 5000);
});

test('report reconciles with orders and is read-only', async () => {
  const shop = new Shop({ n: 2, x: 20 });
  await placeOrders(shop, 2);
  const { code } = shop.generateCoupon();
  const { order } = await shop.checkout(cartWith(shop, 'poster', 2), 'k', { couponCode: code });
  const r1 = shop.report();
  const r2 = shop.report();
  assert.deepEqual(r1, r2);
  assert.equal(r1.totalOrders, 3);
  assert.equal(r1.grossRevenueCents, 2 * 499 + 3150);
  assert.equal(r1.totalDiscountsCents, order.discountCents);
  assert.equal(r1.netRevenueCents, r1.grossRevenueCents - r1.totalDiscountsCents);
  assert.deepEqual(r1.coupons, { generated: 1, available: 0, reserved: 0, redeemed: 1 });
  assert.equal(r1.purchasedQuantityByProduct.poster, 2);
});

test('cart validation: bad quantities, unknown products, mutation after checkout', async () => {
  const shop = new Shop();
  const { id } = shop.createCart();
  for (const q of [0, -1, 1.5, '2', null]) assert.throws(() => shop.addItem(id, { productId: 'tee', quantity: q }), { code: 'INVALID_QUANTITY' });
  assert.throws(() => shop.addItem(id, { productId: 'nope', quantity: 1 }), { code: 'PRODUCT_NOT_FOUND' });
  assert.throws(() => shop.addItem(id, { productId: 'hoodie', quantity: 4 }), { code: 'INSUFFICIENT_STOCK' });
  await assert.rejects(shop.checkout(id, 'k'), { code: 'EMPTY_CART' });
  shop.addItem(id, { productId: 'tee', quantity: 1 });
  await shop.checkout(id, 'k');
  assert.throws(() => shop.addItem(id, { productId: 'tee', quantity: 1 }), (e) => e instanceof ApiError && e.code === 'CART_NOT_OPEN');
});
