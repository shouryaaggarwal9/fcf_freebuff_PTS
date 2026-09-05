/**
 * Deterministic-market verification (run with `bun tests/verify_price.ts`).
 *
 * 1. Golden vectors — price(symbol, sec) must EXACTLY match the pinned
 *    fixture (catches any accidental history rewrite).
 * 2. Tick rule — every price is a multiple of 5 paise (₹0.05).
 * 3. Monotonicity — inside each 60 s anchor segment the price path is
 *    monotone; the settlement oracle relies on this to binary-search.
 * 4. Day-boundary continuity — no artificial gap at 00:00 UTC.
 * 5. Oracle — findFillTick/firstTickWhere agrees with a brute-force scan
 *    over the same window (this is what settles orders retroactively).
 */
import { MARKET_VERSION, SYMBOLS, TICK_PAISE } from "../src/config/market";
import { firstTickWhere, pricePaise } from "../src/engine/price";
import { floorDiv } from "../src/engine/math";

const DAY0 = 1_728_000_000n; // UTC start-of-day used by the fixture
const WINDOW_FROM = 1_700_000_000n;
const WINDOW_TO = 1_700_000_239n; // 240 s = 4 segments

interface Vector {
  symbol: string;
  sec: number;
  pricePaise: number;
}
interface Fixture {
  marketVersion: number;
  vectors: Vector[];
}

const fixture: Fixture = await Bun.file(
  new URL("./fixtures/price_vectors.json", import.meta.url),
).json();

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

/* 1. golden vectors + market version */
check(
  "fixture marketVersion matches MARKET_VERSION",
  fixture.marketVersion === MARKET_VERSION,
  `fixture ${fixture.marketVersion} vs config ${MARKET_VERSION}`,
);
for (const v of fixture.vectors) {
  const actual = pricePaise(v.symbol, BigInt(v.sec));
  check(
    `vector ${v.symbol} @ ${v.sec}`,
    actual === BigInt(v.pricePaise),
    `expected ${v.pricePaise}, got ${actual.toString()}`,
  );
  check(
    `tick multiple ${v.symbol} @ ${v.sec}`,
    actual % BigInt(TICK_PAISE) === 0n,
    `${actual.toString()} not a multiple of ${TICK_PAISE}`,
  );
}

/* 2. monotonicity within 60 s segments (across a day boundary and mid-epoch) */
for (const def of SYMBOLS) {
  for (const segStart of [DAY0 - 120n, DAY0, 1_699_999_980n, WINDOW_FROM]) {
    const diffs: bigint[] = [];
    for (let s = segStart; s < segStart + 60n; s++) {
      diffs.push(pricePaise(def.symbol, s + 1n) - pricePaise(def.symbol, s));
    }
    const nonNeg = diffs.every((d) => d >= 0n);
    const nonPos = diffs.every((d) => d <= 0n);
    check(
      `monotone segment ${def.symbol} @ ${segStart.toString()}`,
      nonNeg || nonPos,
      `diffs=${diffs.join(",")}`,
    );
  }
}

/* 3. day-boundary continuity: |p(D0-1) − p(D0)| is bounded (no gap) */
for (const def of SYMBOLS) {
  const left = pricePaise(def.symbol, DAY0 - 1n);
  const right = pricePaise(def.symbol, DAY0);
  const gap = left > right ? left - right : right - left;
  check(
    `boundary continuity ${def.symbol}`,
    gap <= 30n,
    `gap ${gap.toString()} paise across 00:00 UTC`,
  );
}

/* 4. oracle vs brute force */
function bruteFirst(
  symbol: string,
  fromSec: bigint,
  toSec: bigint,
  pred: (p: bigint) => boolean,
): bigint | null {
  for (let s = fromSec; s <= toSec; s++) {
    if (pred(pricePaise(symbol, s))) return s;
  }
  return null;
}

for (const def of SYMBOLS) {
  let minP = pricePaise(def.symbol, WINDOW_FROM);
  let maxP = minP;
  for (let s = WINDOW_FROM; s <= WINDOW_TO; s++) {
    const p = pricePaise(def.symbol, s);
    if (p < minP) minP = p;
    if (p > maxP) maxP = p;
  }
  const tick = BigInt(TICK_PAISE);
  const mid = floorDiv((minP + maxP) / 2n, tick) * tick; // level inside range
  const below = minP - tick; // never touched from below
  const above = maxP + tick; // never touched from above

  const cases: Array<{
    label: string;
    level: bigint;
    pred: (p: bigint) => boolean;
  }> = [
    { label: "buy-limit-mid", level: mid, pred: (p) => p <= mid },
    { label: "sell-limit-mid", level: mid, pred: (p) => p >= mid },
    { label: "buy-never", level: below, pred: (p) => p <= below },
    { label: "sell-never", level: above, pred: (p) => p >= above },
    { label: "buy-always", level: above, pred: (p) => p <= above },
    { label: "sell-always", level: below, pred: (p) => p >= below },
  ];
  for (const c of cases) {
    const oracle = firstTickWhere(
      def.symbol,
      WINDOW_FROM,
      WINDOW_TO,
      c.pred,
    );
    const brute = bruteFirst(def.symbol, WINDOW_FROM, WINDOW_TO, c.pred);
    check(
      `oracle ${def.symbol} ${c.label}`,
      oracle === brute,
      `oracle=${oracle?.toString() ?? "null"}, brute=${brute?.toString() ?? "null"}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed — engine invariants violated.`);
  process.exit(1);
}
console.log(
  `✓ all checks passed: ${fixture.vectors.length} golden vectors · ${SYMBOLS.length} symbols · monotonicity · boundary continuity · oracle vs brute force`,
);