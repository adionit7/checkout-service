import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { Shop } from '../src/shop.js';

test('HTTP: concurrent identical retries over the wire yield one order (201 + 200 replays)', async (t) => {
  const server = createServer(new Shop());
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, headers = {}) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });

  const cart = await (await call('POST', '/carts')).json();
  const add = await call('POST', `/carts/${cart.id}/items`, { productId: 'hoodie', quantity: 2 });
  assert.equal(add.status, 201);

  const rs = await Promise.all(Array.from({ length: 5 }, () => call('POST', `/carts/${cart.id}/checkout`, {}, { 'Idempotency-Key': 'abc' })));
  const statuses = rs.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 200, 201]);
  const ids = new Set((await Promise.all(rs.map((r) => r.json()))).map((o) => o.id));
  assert.equal(ids.size, 1);

  const report = await (await call('GET', '/admin/report')).json();
  assert.equal(report.totalOrders, 1);
  assert.equal(report.purchasedQuantityByProduct.hoodie, 2);

  const missing = await call('POST', `/carts/${cart.id}/checkout`, {});
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await call('GET', '/orders/nope')).status, 404);
  assert.equal((await call('POST', '/admin/coupons/generate')).status, 409);
});

test('HTTP: two servers are isolated (no shared routing state)', async (t) => {
  const a = createServer(new Shop());
  const b = createServer(new Shop());
  await Promise.all([a, b].map((s) => new Promise((r) => s.listen(0, r))));
  t.after(() => { a.close(); b.close(); });
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  const { id } = await (await fetch(url(a) + '/carts', { method: 'POST' })).json();
  assert.equal((await fetch(`${url(a)}/carts/${id}`)).status, 200);
  assert.equal((await fetch(`${url(b)}/carts/${id}`)).status, 404);
});
