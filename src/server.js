import http from 'node:http';
import { Shop, ApiError } from './shop.js';

const routes = [];
const route = (method, path, handler) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

export function createServer(shop = new Shop()) {
  route('GET', '/products', () => [200, shop.listProducts()]);
  route('POST', '/carts', () => [201, shop.createCart()]);
  route('GET', '/carts/:id', ({ p }) => [200, shop.viewCart(p.id)]);
  route('POST', '/carts/:id/items', ({ p, body }) => [201, shop.addItem(p.id, body)]);
  route('PATCH', '/carts/:id/items/:productId', ({ p, body }) => [200, shop.setQuantity(p.id, p.productId, body.quantity)]);
  route('DELETE', '/carts/:id/items/:productId', ({ p }) => [200, shop.removeItem(p.id, p.productId)]);
  route('POST', '/carts/:id/checkout', async ({ p, body, headers }) => {
    const { order, replayed } = await shop.checkout(p.id, headers['idempotency-key'], body);
    return [replayed ? 200 : 201, order, replayed ? { 'Idempotent-Replayed': 'true' } : {}];
  });
  route('GET', '/orders/:id', ({ p }) => [200, shop.getOrder(p.id)]);
  // Administrative operations (no auth implemented; see DECISIONS.md)
  route('POST', '/admin/coupons/generate', () => [201, shop.generateCoupon()]);
  route('GET', '/admin/coupons', () => [200, shop.listCoupons()]);
  route('GET', '/admin/report', () => [200, shop.report()]);

  return http.createServer(async (req, res) => {
    const send = (status, payload, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(payload));
    };
    try {
      const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
      let matched = null;
      let pathExists = false;
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        pathExists = true;
        if (r.method === req.method) {
          matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
          break;
        }
      }
      if (!matched) throw pathExists ? new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed') : new ApiError(404, 'NOT_FOUND', 'No such route');

      let body = {};
      if (req.method === 'POST' || req.method === 'PATCH') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString();
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
          }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_JSON', 'Body must be a JSON object');
      }
      const [status, payload, extra] = await matched.r.handler({ p: matched.params, body, headers: req.headers });
      send(status, payload, extra);
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: { code: e.code, message: e.message, details: e.details } });
      console.error(e);
      send(500, { error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const shop = new Shop({ n: Number(process.env.COUPON_EVERY_N ?? 5), x: Number(process.env.COUPON_PERCENT ?? 10) });
  const port = Number(process.env.PORT ?? 3000);
  createServer(shop).listen(port, () => console.log(`listening on :${port} (n=${shop.n}, x=${shop.x}%)`));
}
