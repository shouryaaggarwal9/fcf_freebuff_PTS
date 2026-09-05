/**
 * Integer-only arithmetic helpers for the deterministic market engine.
 *
 * Everything here operates on bigint with explicit 64-bit masking so results
 * are bit-identical across JS engines, Bun, Node and the browser — and would
 * be portable to any language with 64-bit integers (the algorithm spec lives
 * alongside price.ts). No floating point anywhere.
 */

export const MASK64 = (1n << 64n) - 1n;

/** Floor division for bigint (JS `/` truncates toward zero). b > 0 in use. */
export function floorDiv(a: bigint, b: bigint): bigint {
  let q = a / b;
  const r = a % b;
  if (r !== 0n && (a < 0n) !== (b < 0n)) {
    q -= 1n;
  }
  return q;
}

/** splitmix64 finalizer — a strong, fast, dependency-free 64-bit avalanche. */
export function splitmix64(x: bigint): bigint {
  x = (x + 0x9e3779b97f4a7c15n) & MASK64;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (x ^ (x >> 31n)) & MASK64;
}

/** FNV-1a 64-bit over the ASCII bytes of a string → stable symbol seed. */
export function fnv1a64(input: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

/**
 * Deterministic bounded "level" hash for an anchor index k on a wave with the
 * given spacing: returns an integer in [-amp, amp] (inclusive).
 */
export function anchorLevel(
  symbolSeed: bigint,
  spacing: bigint,
  amp: bigint,
  k: bigint,
): bigint {
  const mixed = splitmix64(
    symbolSeed ^
      splitmix64(spacing * 0x517cc1b727220a95n) ^
      splitmix64(k * 0x9e3779b97f4a7c15n),
  );
  const span = 2n * amp + 1n;
  const m = ((mixed % span) + span) % span; // in [0, 2*amp]
  return m - amp; // in [-amp, amp]
}

/** True iff x is a multiple of tickPaise (used for input validation). */
export function isMultipleOf(x: bigint, tick: number): boolean {
  return x % BigInt(tick) === 0n;
}
