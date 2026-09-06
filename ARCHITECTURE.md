# NSE Paper Trade Pro — Architecture & Spec Mapping

This document maps the locked build spec to the implementation and records
every place the spec was silent (and the simplest option chosen), plus the
one place it could not be satisfied verbatim.

## Stack substitution (the one deviation)

The spec mandates **Next.js 16 + Supabase (Postgres, Auth, RLS, RPCs,
pg_cron)**. This project runs in the Freebuff web runtime, which provides a
**Vite + React 19 + Convex** platform: the preview server is Vite, and the
managed backend/database is Convex (a serverless TS backend with a serializable
document database, auth, and a free daily cron scheduler). Installing Next.js
would break the platform's managed dev server, and Supabase would require an
external account + credentials this environment does not have.

The substitution was chosen to preserve **every behavioral invariant** of the
spec, which is what the spec itself says to do where a literal reading is
unsatisfiable. The mapping:

| Spec (Next.js/Supabase) | Implementation (Vite/Convex) |
| --- | --- |
| Next.js 16 App Router, `(auth)`/`(dashboard)` route groups | React Router (`/auth`, `/dashboard`) with `RequireAuth` + `returnTo` |
| Supabase Postgres tables + RLS | Convex tables (schema in `src/convex/schema.ts`), auth-gated mutations/queries |
| `supabase gen types` row types | `src/convex/_generated/dataModel` (`Doc<T>`/`Id<T>`) |
| RPCs (`place_order`, `reconcile_user`, …) | Convex mutations in `src/convex/market.ts` |
| `clock_timestamp()` server time | Convex server `Date.now()` inside mutations (never client-supplied) |
| Deterministic price generator in plpgsql | Single TS implementation in `src/engine/price.ts`, imported by server AND browser (no second implementation to drift) |
| `pg_cron` daily sweep | Convex cron (free) in `src/convex/crons.ts` (00:01 UTC) |
| Supabase email confirmation off | Email + password sign-in (`@convex-dev/auth` `Password` provider, Scrypt-hashed server-side) with **no verification and no emails sent** — email + password accounts are recoverable on any device. A one-tap guest (anonymous) login is instant but device-local. |
| `proxy.ts` auth guard | `RequireAuth` wrapper on `/dashboard` |

**Server-authoritative fills (spec §2.3) is preserved exactly:** no client
timestamp, price or epoch ever reaches the backend. `placeOrder` args are
(symbol, side, orderType, qty, limitPaise?, stopPaise?) — levels are the
trader's own desired trigger prices, validated to the 5-paise tick
server-side. The server derives time from its own clock and price from the
deterministic generator. Client tick detection is only a request to
`reconcileUser`, never an assertion.

## Choices made where the spec was silent

- **Session = one UTC calendar day.** The spec's SESSIONS were left as a
  single continuous 24×7 synthetic session (`SYNTH-24x7`, opens 00:00,
  closes 24:00 UTC) so a trading day is exactly a UTC day and intraday rules
  mean every day starts flat. Orders belong to `dayStartSec`; at day end,
  unfilled orders are EXPIRED and leftover positions force-sold at the day's
  last tick (reason `DAY_END`).
- **Retroactive settlement model.** On `reconcile_user` (client-triggered,
  also every 20 s while the tab is open, on tab focus, and via the daily
  cron), every OPEN order is re-evaluated over its eligible ticks
  `[ceil(createdMs/1000), min(now, dayEnd-1)]`. Because price is a pure
  function of (symbol, second), the server finds the exact historical trigger
  tick with `firstTickWhere` — an O(segments · log 10) oracle that binary
  searches inside 10 s anchor segments (price is linear, hence monotone,
  there). An
  order that would have triggered at 03:14 while the user was away fills at
  that exact second at that exact price when they return.
- **Fill pricing.** LIMIT orders fill at the trigger tick's own price
  (at-or-better); STOP orders fill at exactly the stop level (documented
  "guaranteed stop" simplification); orders already marketable at placement
  fill immediately at spot.
- **Cash reservations.** Resting BUY orders reserve `qty × refPrice` (limit,
  stop, or spot) out of the wallet with paired `reserve`/`reserve_release`
  ledger entries; because fill ≤ reserved for resting orders, a fill always
  leaves the wallet non-negative. Wallet arithmetic is bigint paise end to
  end; no floats anywhere.
- **Sell capacity + OCO-lite.** Open sells are capped at today's held
  quantity (`validateSellCapacity`); after a SELL fill, sibling OPEN sells on
  the same (symbol, day) are cancelled newest-first when they would exceed
  remaining holdings, giving natural stop-loss/target bracket behaviour.
- **Realized P&L is stored, never recomputed.** Each SELL fill records
  `realizedPnlPaise = (fill − avgCost) × qty` and `avgCostAtFillPaise` on the
  order; the UI reads those stored values only.
- **Determinism verification.** `tests/fixtures/price_vectors.json` pins 140
  (symbol, second) → paise outputs; `bun run verify:price` checks the pins,
  the 5-paise tick rule, intra-segment monotonicity (the property the oracle
  relies on), 00:00 UTC continuity, and oracle-vs-brute-force agreement.
  Regenerate vectors with `bun tests/generate_vectors.ts` only when
  `MARKET_VERSION` in `src/config/market.ts` is bumped.
- **Money display.** All money is integer paise (`bigint`) in the engine,
  ledger and wallet; floats appear only at the chart/label rendering boundary
  (pixels need numbers), never in any price/P&L computation.

## Accepted limitations (documented by project decision)

- **Emails are never verified; nothing is ever sent to an inbox.** There is
  no email handler and no OTP/password-reset flow. The email is the sign-in
  credential id (stored lowercased) and the password is Scrypt-hashed by
  Convex Auth. Accepted consequences for a demo: anyone can claim any
  email (no proof of ownership), so a claimed email is not identity proof.
- **Cross-device login works via email + password** — that is the point of
  the password. The same email cannot create a second account (sign-up
  rejects duplicates).
- **A forgotten password is unrecoverable** (no reset without an email
  handler), and **guest (anonymous) sessions are device-local** — they have
  no credentials, so clearing browser data or switching devices loses
  access to that account's history (the data stays in the DB, unreachable).

## Invariant checklist

- [x] Deterministic, immutable past: `price(symbol, epochSec)` — integer
  hashing (FNV-1a/splitmix64 over 64-bit bigints), piecewise-linear
  multi-scale waves (86400/21600/3600/900/300/60/10 s) on a 10 s anchor
  grid, no floats/transcendentals/`Math.random`. Bit-identical across
  engines; portable to plpgsql-style integer arithmetic if it ever needs to
  move back to Postgres. (v2, 2026-09-06: added sub-minute waves + 10 s grid
  so 1m/5m candles carry wicks and colors decorrelate; v1 history was
  settled and closed at the cutover — see MARKET_VERSION notes.)
- [x] Server is sole authority for fills, time and money.
- [x] Integer paise everywhere; ₹0.05 tick enforced server-side.
- [x] Strict TypeScript, no `any`; `bun tsc -b --noEmit` clean.
- [x] Engine (ticking/chart generation) runs only in the browser; settlement
  only on the server.
- [x] Zero external cost: Convex free tier + free cron; no market-data API.