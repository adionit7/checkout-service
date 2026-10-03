# DECISIONS

## Invariants
1. `stock >= 0`; units sold in placed orders + stock = initial stock (+ units held by in-flight checkouts).
2. A cart produces at most one placed order.
3. A (cart, Idempotency-Key) pair produces at most one order, no matter how often or how concurrently it is sent.
4. A coupon is redeemed by at most one placed order; it is never consumed by a failed checkout.
5. At most one coupon per milestone; coupons issued <= floor(placedOrders / n).
6. `0 <= total <= subtotal`; order = immutable snapshot of what was bought and how the total was derived.
7. Report = pure function of placed orders + coupons (`gross - discounts = net`, no mutation).

## Ambiguities and chosen semantics
- **"Nth order"**: counts only *placed* (paid) orders. Failed payments don't advance the counter. Milestone *k* = order number k·n. Eligibility is `floor(placed/n) > couponsIssued`; unclaimed milestones accumulate, and admin generates them one call at a time.
- **Coupon scope**: bearer coupon, any customer/cart, percent off the whole subtotal, no expiry, single use, one coupon per order. A coupon exists only after admin generates it, so it can't apply to the order that triggered the milestone.
- **Price changes after add-to-cart**: the cart stores product + quantity only; the *current* price is charged. Cart view flags `priceChangedSinceAdded`. Clients may send `expectedSubtotalCents` at checkout to get 409 `PRICE_CHANGED` instead of a surprise. Rationale: charging a stale price is a revenue leak; silently charging a higher one is a trust problem, so we make it opt-out-able.
- **Availability changes**: add/update checks stock for fast feedback only; *checkout* is the authority → 409 `INSUFFICIENT_STOCK` listing every short line. Carts do not reserve stock (abandoned carts would otherwise hold inventory).
- **Order visibility**: only `placed` orders are retrievable; payment-failed attempts are retained internally and excluded from reporting.

## Decisions

### Decision: Reserve → pay → confirm/compensate
**Context:** Payment is an external, slow step; we must not oversell while it runs, and must not lose a coupon if it fails.
**Options:** (a) check, pay, then decrement; (b) hold everything for the whole call (lock); (c) reserve state first, pay, then confirm or compensate.
**Choice:** (c). Validation + stock decrement + coupon `available→reserved` + cart `open→checking_out` happen in one atomic block; payment is awaited; then either `placed/redeemed/checked_out` or full rollback.
**Why:** (a) oversells; (b) serialises all checkouts behind payment latency. **Consequences:** a `reserved` coupon/stock state exists transiently (visible in the report as `reserved`); a crash mid-payment would strand a reservation in a real system (needs a recovery sweep; see Deferred).

### Decision: Concurrency via synchronous critical sections on an in-memory store
**Context:** Need provable atomicity without a DB.
**Options:** mutex library; SQLite transactions; synchronous blocks on Node's single thread.
**Choice:** Every check-then-write sequence (`#placeOrder` reserve/confirm blocks, `generateCoupon`, cart mutations) contains no `await`, so it cannot interleave. The fake payment yields the event loop on purpose, so tests really interleave checkouts.
**Why:** Simplest correct option at this scale; zero dependencies. **Consequences:** single process only (see scale section). The invariant is fragile to someone adding an `await` inside a block; comments mark the blocks.

### Decision: Idempotency-Key required, scoped per cart, in-flight dedup
**Options:** rely only on cart state (second checkout → 409); key only; both.
**Choice:** Both. The key map stores the *promise* (registered before any await), so concurrent duplicates await the same outcome instead of racing. Replay returns 200 + the original order. A different key on a finished cart → 409 `CART_ALREADY_CHECKED_OUT` (so even a buggy client can't double-order). Same key + different body → 422. **Failures aren't cached**, so a client can fix the cart (or payment) and retry with the same key.
**Consequences:** the key store is unbounded in memory (needs TTL in production).

### Decision: Integer cents; discount rounds down
`discount = floor(subtotal * percent / 100)`, capped at subtotal; per-order, applied to the subtotal, not per line (deterministic, no per-line rounding drift). Floor means the customer never gets more than the stated percent. Coupon percent is validated by config only; the cap guarantees a non-negative total even for a misconfigured x > 100 (tested).

### Decision: Coupons reserved, not consumed, until payment succeeds
Alternative: mark redeemed up-front and restore on failure (window where state lies), or redeem after payment (two checkouts could both pass validation and both be charged). Reserved state closes both. A second checkout presenting a reserved coupon gets 409 `COUPON_UNAVAILABLE` (retryable if the first fails).

### Decision: Fake payment abstraction
`payments.charge({orderId, amountCents}) → {ok}` is injected into `Shop`. Lets tests force declines and gives the reserve/compensate path a real seam. Successful checkout = payment success in the default fake.

### Decision: Error model
Stable machine `code` + human message + structured `details`. 400 malformed input, 404 missing resource, 409 state conflicts the client can resolve (stock, price, coupon used, cart state), 422 well-formed but semantically invalid (empty cart, unknown coupon, key reuse), 402 payment declined.

## Admin
No auth implemented. Treated as administrative: everything under `/admin/*`. In production: separate auth scope/role.

## Implemented vs deferred
**Implemented:** everything in the brief with in-memory persistence, tests for concurrency/retry/failure/money/reporting.
**Deferred:** persistence across restarts; auth; pagination; idempotency-key TTL; recovery of reservations after a crash mid-payment; coupon expiry; cart expiry; rate limiting; OpenAPI file (README table instead); structured logging/metrics.

## Evolving to multiple instances / production
Move state to Postgres. Stock: `UPDATE products SET stock = stock - $q WHERE id=$1 AND stock >= $q` (0 rows = conflict) inside one transaction with order insert. Idempotency: table with `UNIQUE(cart_id, key)`, insert-first so the DB arbitrates concurrent duplicates. Coupons: `UPDATE coupons SET status='redeemed' WHERE code=$1 AND status='available'`, plus `UNIQUE(milestone)` so concurrent generation can't duplicate; milestone derived from a count read under a lock (or an advisory lock / counter row). Payment: keep reserve → pay → confirm as separate transactions with a sweeper that expires `pending` orders; real provider call carries our idempotency key. Report from a read replica or materialised aggregates.

## AI usage
_To be completed by the author before submission, in their own words: which tools were used, and one concrete example where AI output was corrected/rejected/redirected (e.g. a race or rounding rule you caught). This section must reflect what actually happened._

## If I had two more hours
1. Randomised interleaving/property test comparing stock, coupons and report to a model after thousands of operations.
2. Crash-recovery for `pending` orders and an expiry for idempotency keys.
3. Swap in SQLite/Postgres to validate the SQL-level invariants above, and an OpenAPI spec.
