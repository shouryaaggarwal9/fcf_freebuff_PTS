/**
 * Display/format helpers for NSE Paper Trade Pro.
 *
 * All money/price arithmetic stays in integer paise (bigint). These functions
 * only convert to STRINGS for the UI — they never produce float money values.
 * Prices are shown in ₹ with Indian digit grouping (1,23,456.78) and 2 paise
 * digits; IST = UTC+05:30 is used for time labels (display only; storage is
 * UTC epoch seconds/ms).
 */

import { ConvexError } from "convex/values";
import { IST_OFFSET_SECONDS } from "@/config/market";

/** Group a positive integer digit string Indian-style: 12345678 -> 1,23,45,678. */
export function groupIndian(digits: string): string {
  const s = digits.replace(/^0+(?=\d)/, "");
  if (s.length <= 3) return s;
  const head = s.slice(0, s.length - 3);
  const tail = s.slice(-3);
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + tail;
}

function absPaise(value: bigint | number): { negative: boolean; abs: bigint } {
  const p = typeof value === "number" ? BigInt(Math.round(value)) : value;
  return p < 0n ? { negative: true, abs: -p } : { negative: false, abs: p };
}

/** ₹1,23,456.78 from integer paise. Always 2 paise digits. */
export function formatINR(value: bigint | number): string {
  const { negative, abs } = absPaise(value);
  const rupees = abs / 100n;
  const paise = abs % 100n;
  const frac = paise.toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${groupIndian(rupees.toString())}.${frac}`;
}

/** +₹1,234.00 / -₹1,234.00 — explicit sign for P&L readouts. */
export function signedINR(value: bigint | number): string {
  const { negative, abs } = absPaise(value);
  if (abs === 0n) return formatINR(0n);
  const rupees = abs / 100n;
  const paise = abs % 100n;
  const frac = paise.toString().padStart(2, "0");
  return `${negative ? "-" : "+"}₹${groupIndian(rupees.toString())}.${frac}`;
}

/** ₹ in Indian short notation: ₹10.00L, ₹1.25Cr, otherwise plain. */
export function formatINRCompact(value: bigint | number): string {
  const { negative, abs } = absPaise(value);
  const rupees = abs / 100n;
  const LAKH = 100_000n;
  const CRORE = 10_000_000n;
  const sign = negative ? "-" : "";
  if (rupees >= CRORE) {
    const scaled = (abs * 100n) / (CRORE * 100n); // hundredths of a crore
    const whole = scaled / 100n;
    const frac = (scaled % 100n).toString().padStart(2, "0");
    return `${sign}₹${whole.toString()}.${frac}Cr`;
  }
  if (rupees >= LAKH) {
    const scaled = (abs * 100n) / (LAKH * 100n);
    const whole = scaled / 100n;
    const frac = (scaled % 100n).toString().padStart(2, "0");
    return `${sign}₹${whole.toString()}.${frac}L`;
  }
  return `${sign}₹${groupIndian(rupees.toString())}`;
}

/** Parse a user-typed ₹ price ("2,901.35", "-12", "₹1,234.5") to paise, or null. */
export function parseINRToPaise(input: string): bigint | null {
  const cleaned = input.trim().replace(/[₹,\s]/g, "");
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const rupees = BigInt(match[2]);
  const frac = (match[3] ?? "").padEnd(2, "0");
  const paise = rupees * 100n + BigInt(frac === "" ? "0" : frac);
  return sign * paise;
}

/* --------------------------------- time ---------------------------------- */

const IST_MS = IST_OFFSET_SECONDS * 1000;

function istDate(epochSecOrMs: number): Date {
  const ms =
    epochSecOrMs < 100_000_000_000 ? epochSecOrMs * 1000 : epochSecOrMs;
  return new Date(ms + IST_MS);
}

const pad2 = (n: number) => n.toString().padStart(2, "0");

/** "14:35" (IST). Accepts epoch seconds or ms (auto-detected). */
export function istTimeLabel(epochSecOrMs: number): string {
  const d = istDate(epochSecOrMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** "14:35:22" (IST). */
export function istTimeFull(epochSecOrMs: number): string {
  const d = istDate(epochSecOrMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(
    d.getUTCSeconds(),
  )}`;
}

/** "03 Sep 26" (IST). */
export function istDayLabel(epochSecOrMs: number): string {
  const d = istDate(epochSecOrMs);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${pad2(d.getUTCDate())} ${months[d.getUTCMonth()]} ${String(
    d.getUTCFullYear(),
  ).slice(2)}`;
}

/** "Wed, 03 Sep" (IST). */
export function istDayName(epochSecOrMs: number): string {
  const d = istDate(epochSecOrMs);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${days[d.getUTCDay()]}, ${pad2(d.getUTCDate())} ${
    months[d.getUTCMonth()]
  }`;
}

/* -------------------------------- errors --------------------------------- */

/** Pull a human message out of a thrown value (ConvexError, Error, string). */
export function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as unknown;
    if (data && typeof data === "object" && "message" in data) {
      const m = (data as { message?: unknown }).message;
      if (typeof m === "string" && m.length > 0) return m;
    }
    return "Request failed";
  }
  if (err instanceof Error) return err.message || "Request failed";
  if (typeof err === "string") return err;
  return "Request failed";
}
