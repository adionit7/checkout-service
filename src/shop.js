import { randomUUID, randomBytes } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const err = (...a) => new ApiError(...a);

// Money is integer cents everywhere. Percent discounts round DOWN to a whole cent.
export const discountCents = (subtotal, percent) => Math.floor((subtotal * percent) / 100);

export const seedProducts = () => [
  { id: 'tee', name: 'T-Shirt', priceCents: 1999, stock: 100 },
  { id: 'mug', name: 'Coffee Mug', priceCents: 1250, stock: 50 },
  { id: 'sticker', name: 'Sticker Pack', priceCents: 499, stock: 500 },
  { id: 'poster', name: 'Poster', priceCents: 1575, stock: 20 },
  { id: 'hoodie', name: 'Limited Hoodie', priceCents: 5999, stock: 3 }, // limited inventory
];

// Fake payment provider. Async on purpose: it yields the event loop, so concurrent
// checkouts genuinely interleave and the reserve/confirm/compensate path is exercised.
export const fakePayments = {
  async charge() {
    await new Promise((r) => setImmediate(r));
    return { ok: true };
  },
};

/**
 * All state lives here. Every invariant-critical read-check-write sequence is a
 * *synchronous* block (no `await` inside), which makes it atomic on Node's single thread.
 * The only await (payment) happens between a "reserve" block and a "confirm/compensate"
 * block. See DECISIONS.md for how this maps to DB transactions.
 */
export class Shop {
  constructor({ n = 5, x = 10, payments = fakePayments, products = seedProducts() } = {}) {
    this.n = n; // every nth placed order unlocks a coupon
    this.x = x; // coupon percent off
    this.payments = payments;
    this.products = new Map(products.map((p) => [p.id, { ...p }]));
    this.carts = new Map();
    this.orders = new Map();
    this.coupons = new Map(); // code -> coupon
    this.idempotency = new Map(); // `${cartId}:${key}` -> { fingerprint, promise }
    this.placedCount = 0;
  }

  // ---------- products ----------
  listProducts() {
    return [...this.products.values()].map((p) => ({ ...p }));
  }

  #product(id) {
    const p = this.products.get(id);
    if (!p) throw err(404, 'PRODUCT_NOT_FOUND', `Product '${id}' does not exist`);
    return p;
  }

  // ---------- carts ----------
  createCart() {
    const cart = { id: randomUUID(), status: 'open', items: new Map(), orderId: null };
    this.carts.set(cart.id, cart);
    return this.viewCart(cart.id);
  }

  #cart(id) {
    const c = this.carts.get(id);
    if (!c) throw err(404, 'CART_NOT_FOUND', `Cart '${id}' does not exist`);
    return c;
  }

  #openCart(id) {
    const c = this.#cart(id);
    if (c.status !== 'open') {
      throw err(409, 'CART_NOT_OPEN', `Cart is ${c.status} and can no longer be modified`, { orderId: c.orderId });
    }
    return c;
  }

  static #qty(q) {
    if (!Number.isInteger(q) || q < 1 || q > 1000) {
      throw err(400, 'INVALID_QUANTITY', 'quantity must be an integer between 1 and 1000');
    }
    return q;
  }

  viewCart(id) {
    const cart = this.#cart(id);
    let subtotal = 0;
    const lines = [...cart.items].map(([productId, line]) => {
      const p = this.products.get(productId);
      const lineTotal = p.priceCents * line.quantity;
      subtotal += lineTotal;
      return {
        productId,
        name: p.name,
        quantity: line.quantity,
        unitPriceCents: p.priceCents,
        lineTotalCents: lineTotal,
        // Informational warnings; checkout re-validates authoritatively.
        priceChangedSinceAdded: p.priceCents !== line.priceAtAddCents,
        priceAtAddCents: line.priceAtAddCents,
        availableStock: p.stock,
        inStock: p.stock >= line.quantity,
      };
    });
    return { id: cart.id, status: cart.status, orderId: cart.orderId, lines, subtotalCents: subtotal, currency: 'USD' };
  }

  addItem(cartId, { productId, quantity }) {
    const cart = this.#openCart(cartId);
    Shop.#qty(quantity);
    if (typeof productId !== 'string') throw err(400, 'INVALID_PRODUCT', 'productId is required');
    const p = this.#product(productId);
    const existing = cart.items.get(productId);
    const next = (existing?.quantity ?? 0) + quantity;
    if (next > 1000) throw err(400, 'INVALID_QUANTITY', 'quantity per product is capped at 1000');
    if (next > p.stock) {
      throw err(409, 'INSUFFICIENT_STOCK', `Only ${p.stock} of '${productId}' available`, { productId, requested: next, available: p.stock });
    }
    cart.items.set(productId, { quantity: next, priceAtAddCents: existing?.priceAtAddCents ?? p.priceCents });
    return this.viewCart(cartId);
  }

  setQuantity(cartId, productId, quantity) {
    const cart = this.#openCart(cartId);
    Shop.#qty(quantity);
    const line = cart.items.get(productId);
    if (!line) throw err(404, 'ITEM_NOT_IN_CART', `'${productId}' is not in this cart`);
    const p = this.#product(productId);
    if (quantity > p.stock) {
      throw err(409, 'INSUFFICIENT_STOCK', `Only ${p.stock} of '${productId}' available`, { productId, requested: quantity, available: p.stock });
    }
    line.quantity = quantity;
    return this.viewCart(cartId);
  }

  removeItem(cartId, productId) {
    const cart = this.#openCart(cartId);
    if (!cart.items.delete(productId)) throw err(404, 'ITEM_NOT_IN_CART', `'${productId}' is not in this cart`);
    return this.viewCart(cartId);
  }

  // ---------- checkout ----------
  /** Returns { order, replayed }. Safe to retry with the same Idempotency-Key. */
  async checkout(cartId, idempotencyKey, { couponCode, expectedSubtotalCents } = {}) {
    if (!idempotencyKey) throw err(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    this.#cart(cartId);
    if (couponCode != null && typeof couponCode !== 'string') throw err(400, 'INVALID_COUPON', 'couponCode must be a string');
    if (expectedSubtotalCents != null && !Number.isInteger(expectedSubtotalCents)) {
      throw err(400, 'INVALID_EXPECTED_SUBTOTAL', 'expectedSubtotalCents must be an integer');
    }

    const k = `${cartId}:${idempotencyKey}`;
    const fingerprint = JSON.stringify([couponCode ?? null, expectedSubtotalCents ?? null]);
    const prior = this.idempotency.get(k);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw err(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request body');
      }
      const r = await prior.promise; // in-flight or completed: same outcome
      return { order: r.order, replayed: true };
    }

    // Registered synchronously (before any await) so a concurrent duplicate always finds it.
    const promise = this.#placeOrder(cartId, { couponCode, expectedSubtotalCents });
    this.idempotency.set(k, { fingerprint, promise });
    try {
      return await promise;
    } catch (e) {
      this.idempotency.delete(k); // failures are not cached: client may fix the problem and retry
      throw e;
    }
  }

  async #placeOrder(cartId, { couponCode, expectedSubtotalCents }) {
    // ===== RESERVE (synchronous = atomic) =====
    const cart = this.#cart(cartId);
    if (cart.status === 'checked_out') {
      throw err(409, 'CART_ALREADY_CHECKED_OUT', 'This cart was already checked out', { orderId: cart.orderId });
    }
    if (cart.status === 'checking_out') throw err(409, 'CHECKOUT_IN_PROGRESS', 'Another checkout of this cart is in progress');
    if (cart.items.size === 0) throw err(422, 'EMPTY_CART', 'Cart has no items');

    const lines = [];
    const shortages = [];
    let subtotal = 0;
    for (const [productId, { quantity }] of cart.items) {
      const p = this.products.get(productId);
      if (p.stock < quantity) shortages.push({ productId, requested: quantity, available: p.stock });
      const lineTotalCents = p.priceCents * quantity; // price is the CURRENT price (see DECISIONS.md)
      subtotal += lineTotalCents;
      lines.push({ productId, name: p.name, quantity, unitPriceCents: p.priceCents, lineTotalCents });
    }
    if (shortages.length) throw err(409, 'INSUFFICIENT_STOCK', 'Some items are no longer available in the requested quantity', { shortages });
    if (expectedSubtotalCents != null && expectedSubtotalCents !== subtotal) {
      throw err(409, 'PRICE_CHANGED', 'Cart subtotal differs from the one the client confirmed', {
        expectedSubtotalCents,
        currentSubtotalCents: subtotal,
      });
    }

    let coupon = null;
    if (couponCode != null) {
      coupon = this.coupons.get(couponCode);
      if (!coupon) throw err(422, 'COUPON_NOT_FOUND', `Coupon '${couponCode}' does not exist`);
      if (coupon.status !== 'available') {
        throw err(409, 'COUPON_UNAVAILABLE', `Coupon is ${coupon.status}`, { status: coupon.status });
      }
    }
    const discount = coupon ? Math.min(subtotal, discountCents(subtotal, coupon.percentOff)) : 0;

    // All validation passed: from here on nothing throws until the await.
    for (const l of lines) this.products.get(l.productId).stock -= l.quantity;
    if (coupon) coupon.status = 'reserved';
    cart.status = 'checking_out';
    const order = {
      id: randomUUID(),
      cartId,
      status: 'pending',
      lines,
      subtotalCents: subtotal,
      couponCode: coupon?.code ?? null,
      couponPercentOff: coupon?.percentOff ?? null,
      discountCents: discount,
      totalCents: subtotal - discount,
      currency: 'USD',
      sequence: null,
      createdAt: new Date().toISOString(),
    };
    this.orders.set(order.id, order);

    // ===== PAYMENT (the only await) =====
    let paid = false;
    try {
      paid = (await this.payments.charge({ orderId: order.id, amountCents: order.totalCents }))?.ok === true;
    } catch {
      paid = false;
    }

    // ===== CONFIRM or COMPENSATE (synchronous = atomic) =====
    if (!paid) {
      for (const l of lines) this.products.get(l.productId).stock += l.quantity;
      if (coupon) coupon.status = 'available'; // coupon is never lost by a failed checkout
      cart.status = 'open';
      order.status = 'payment_failed';
      throw err(402, 'PAYMENT_FAILED', 'Payment was declined; nothing was reserved or consumed', { orderId: order.id });
    }
    order.status = 'placed';
    order.sequence = ++this.placedCount;
    order.placedAt = new Date().toISOString();
    if (coupon) {
      coupon.status = 'redeemed';
      coupon.redeemedByOrderId = order.id;
    }
    cart.status = 'checked_out';
    cart.orderId = order.id;
    return { order: structuredClone(order), replayed: false };
  }

  getOrder(id) {
    const o = this.orders.get(id);
    if (!o || o.status !== 'placed') throw err(404, 'ORDER_NOT_FOUND', `Order '${id}' does not exist`);
    return structuredClone(o);
  }

  // ---------- admin ----------
  generateCoupon() {
    // Synchronous: check-and-create cannot interleave, so one milestone yields one coupon.
    const earned = Math.floor(this.placedCount / this.n);
    const issued = this.coupons.size;
    if (issued >= earned) {
      throw err(409, 'NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone has been reached', {
        placedOrders: this.placedCount,
        nextMilestoneAtOrder: (issued + 1) * this.n,
      });
    }
    const coupon = {
      code: `SAVE${this.x}-${randomBytes(4).toString('hex').toUpperCase()}`,
      percentOff: this.x,
      milestone: issued + 1,
      status: 'available',
      redeemedByOrderId: null,
      createdAt: new Date().toISOString(),
    };
    this.coupons.set(coupon.code, coupon);
    return { ...coupon };
  }

  listCoupons() {
    return [...this.coupons.values()].map((c) => ({ ...c }));
  }

  /** Pure read: derived from placed orders and coupons only. */
  report() {
    const placed = [...this.orders.values()].filter((o) => o.status === 'placed');
    const byProduct = {};
    let gross = 0;
    let discounts = 0;
    for (const o of placed) {
      gross += o.subtotalCents;
      discounts += o.discountCents;
      for (const l of o.lines) byProduct[l.productId] = (byProduct[l.productId] ?? 0) + l.quantity;
    }
    const coupons = [...this.coupons.values()];
    const count = (s) => coupons.filter((c) => c.status === s).length;
    return {
      totalOrders: placed.length,
      purchasedQuantityByProduct: byProduct,
      grossRevenueCents: gross,
      totalDiscountsCents: discounts,
      netRevenueCents: gross - discounts,
      coupons: { generated: coupons.length, available: count('available'), reserved: count('reserved'), redeemed: count('redeemed') },
      currency: 'USD',
    };
  }
}
