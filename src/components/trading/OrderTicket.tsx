/**
 * OrderTicket — the trader's order entry form.
 *
 * Everything submitted goes through server mutations ONLY: placeOrder takes
 * (symbol, side, orderType, qty, limitPaise?, stopPaise?) and the Convex
 * backend derives time + spot price itself. The client never sends a
 * timestamp or a market price — levels (limit/stop) are the trader's own
 * desired trigger prices, validated to the 5-paise tick server-side.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SYMBOLS, TICK_PAISE } from "@/config/market";
import { pricePaise } from "@/engine/price";
import { orderIntent } from "@/lib/position";
import { cn } from "@/lib/utils";
import { formatINR, parseINRToPaise } from "@/lib/format";
import { Loader2, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Side = "BUY" | "SELL";
type OrderKind = "MARKET" | "LIMIT" | "STOP";

export interface TicketPrefill {
  symbol: string;
  side: Side;
  qty?: number;
}

interface OrderTicketProps {
  symbol: string;
  onSymbolChange: (symbol: string) => void;
  nowSec: number;
  availableCashPaise: bigint;
  heldQty: number; // today's position qty for the selected symbol (0 = flat)
  positionSide: "LONG" | "SHORT" | null; // null = flat
  /** Resting unlinked orders per side — the OCO partner candidate. */
  pendingBuyQty: number;
  pendingSellQty: number;
  onPlace: (args: {
    symbol: string;
    side: Side;
    orderType: OrderKind;
    qty: number;
    limitPaise?: bigint;
    stopPaise?: bigint;
  }) => Promise<void>;
  prefill: TicketPrefill | null;
  className?: string;
}

const KIND_TABS: { kind: OrderKind; label: string }[] = [
  { kind: "MARKET", label: "Market" },
  { kind: "LIMIT", label: "Limit" },
  { kind: "STOP", label: "SL" },
];

export function OrderTicket({
  symbol,
  onSymbolChange,
  nowSec,
  availableCashPaise,
  heldQty,
  positionSide,
  pendingBuyQty,
  pendingSellQty,
  onPlace,
  prefill,
  className,
}: OrderTicketProps) {
  const spot = pricePaise(symbol, BigInt(nowSec));
  const [side, setSide] = useState<Side>("BUY");
  const [kind, setKind] = useState<OrderKind>("MARKET");
  const [qtyStr, setQtyStr] = useState("10");
  const [limitStr, setLimitStr] = useState("");
  const [stopStr, setStopStr] = useState("");
  const [busy, setBusy] = useState(false);

  // Apply a prefill (position sell, watchlist shortcut) — only on change.
  useEffect(() => {
    if (!prefill) return;
    onSymbolChange(prefill.symbol);
    setSide(prefill.side);
    if (prefill.qty !== undefined) setQtyStr(String(prefill.qty));
    if (prefill.side === "SELL") setKind("MARKET");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const isBuy = side === "BUY";
  const levelPaise = useMemo(() => {
    const raw = kind === "LIMIT" ? limitStr : kind === "STOP" ? stopStr : "";
    return raw.trim() === "" ? null : parseINRToPaise(raw);
  }, [kind, limitStr, stopStr]);

  const pricePaiseValue =
    kind === "MARKET"
      ? spot
      : levelPaise !== null
        ? levelPaise
        : spot;

  const qty = /^\d+$/.test(qtyStr.trim()) ? parseInt(qtyStr.trim(), 10) : 0;
  const isShort = positionSide === "SHORT";
  const shorting = side === "SELL" && !isShort; // FLAT/LONG + SELL means short-entry only when flat
  const opensShort = side === "SELL" && positionSide === null;
  const coversShort = side === "BUY" && isShort;
  const intent = orderIntent(
    positionSide === null ? null : { side: positionSide, qty: heldQty },
    side,
  );
  const maxBuyQty =
    isBuy && pricePaiseValue > 0n && !isShort
      ? availableCashPaise / pricePaiseValue
      : 0n;
  const notional = BigInt(qty) * pricePaiseValue;
  // Margin preview: shorts block 2× notional (+ headroom when resting).
  const marginEstimate =
    opensShort || intent === "ADD_SHORT" ? 2n * notional + (kind === "MARKET" ? 0n : 2n * BigInt(qty) * 100n) : 0n;

  const error = useMemo<string | null>(() => {
    if (qty <= 0 || qty > 1_000_000) return "Enter a valid quantity (1–10,00,000).";
    if (kind === "LIMIT") {
      if (levelPaise === null) return "Enter a limit price.";
      if (levelPaise % BigInt(TICK_PAISE) !== 0n)
        return "Price must be a multiple of ₹0.05 (5 paise).";
    }
    if (kind === "STOP") {
      if (levelPaise === null) return "Enter a stop price.";
      if (levelPaise % BigInt(TICK_PAISE) !== 0n)
        return "Price must be a multiple of ₹0.05 (5 paise).";
      if (side === "SELL" && levelPaise >= spot)
        return "Sell stop must be below the current market price.";
      if (side === "BUY" && levelPaise <= spot)
        return "Buy stop must be above the current market price.";
    }
    if (coversShort && qty > heldQty)
      return `Short is ${heldQty} ${symbol} — buying more would flip the position.`;
    if (side === "SELL" && isShort)
      return `You are SHORT ${heldQty} ${symbol} — selling adds to the short (margin 2× notional).`;
    if (
      side === "SELL" &&
      !opensShort &&
      !isShort &&
      qty > heldQty
    )
      return `You hold ${heldQty} ${symbol} today — sell quantity exceeds it.`;
    if (side === "BUY" && !coversShort && notional > availableCashPaise)
      return `Needs ${formatINR(notional)} — above available cash ${formatINR(availableCashPaise)}.`;
    if ((opensShort || intent === "ADD_SHORT") && marginEstimate > availableCashPaise)
      return `Needs ${formatINR(marginEstimate)} margin — above available cash ${formatINR(availableCashPaise)}.`;
    return null;
  }, [
    qty,
    kind,
    levelPaise,
    side,
    heldQty,
    symbol,
    notional,
    availableCashPaise,
    coversShort,
    opensShort,
    isShort,
    marginEstimate,
    spot,
    spot,
  ]);

  const snapToTick = (p: bigint): bigint => {
    const t = BigInt(TICK_PAISE);
    const snapped = (p / t) * t;
    return p % t === 0n ? p : snapped;
  };

  const fillFromSpot = (offsetPct?: number) => {
    const base = pricePaise(symbol, BigInt(nowSec));
    const price =
      offsetPct === undefined
        ? base
        : (base * BigInt(100 + offsetPct)) / 100n;
    const snapped = snapToTick(price < 0n ? 0n : price);
    const str = formatINR(snapped).replace("₹", "");
    if (kind === "LIMIT") setLimitStr(str);
    if (kind === "STOP") setStopStr(str);
  };

  const submit = async () => {
    if (busy || error) return;
    setBusy(true);
    try {
      await onPlace({
        symbol,
        side,
        orderType: kind,
        qty,
        ...(kind === "LIMIT" && levelPaise !== null ? { limitPaise: levelPaise } : {}),
        ...(kind === "STOP" && levelPaise !== null ? { stopPaise: levelPaise } : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  const buttonLabel = kind === "MARKET" ? `${isBuy ? "Buy" : "Sell"} at Market` : kind === "LIMIT" ? `${isBuy ? "Buy" : "Sell"} Limit` : `${isBuy ? "Buy" : "Sell"} Stop`;

  return (
    <section className={cn("flex flex-col gap-4", className)}>
      {/* Symbol + side */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
            Order Ticket
          </h3>
          <span className="tnum font-mono text-[11px] text-muted-foreground">
            LTP <span className="font-semibold text-foreground">{formatINR(spot)}</span>
          </span>
        </div>
        <Select value={symbol} onValueChange={onSymbolChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Symbol" />
          </SelectTrigger>
          <SelectContent>
            {SYMBOLS.map((d) => (
              <SelectItem key={d.symbol} value={d.symbol}>
                <span className="font-mono font-semibold">{d.symbol}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {d.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Side toggle */}
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/40 p-1">
        {(["BUY", "SELL"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-bold tracking-wide transition-colors",
              side === s
                ? s === "BUY"
                  ? "bg-up/15 text-up"
                  : "bg-down/15 text-down"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s === "BUY" ? "BUY" : "SELL"}
          </button>
        ))}
      </div>

      {/* Order kind */}
      <div className="flex items-center gap-1">
        {KIND_TABS.map((t) => (
          <Button
            key={t.kind}
            type="button"
            variant={kind === t.kind ? "default" : "ghost"}
            size="sm"
            className={cn(
              "flex-1",
              kind !== t.kind && "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setKind(t.kind)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {/* Quantity */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="qty" className="text-xs font-medium text-muted-foreground">
            Quantity
          </label>
          <span className="text-[10px] text-muted-foreground">
            {isShort
              ? `SHORT ${heldQty} · margin ${formatINR(availableCashPaise)} cash`
              : isBuy
                ? `Cash ${formatINR(availableCashPaise)}`
                : heldQty > 0
                  ? `LONG ${heldQty} ${symbol}`
                  : "Flat — SELL opens a short"}
          </span>
        </div>
        <Input
          id="qty"
          inputMode="numeric"
          value={qtyStr}
          onChange={(e) => setQtyStr(e.target.value.replace(/[^\d]/g, ""))}
          className="tnum font-mono"
          maxLength={7}
        />
        <div className="flex gap-1.5">
          {[10, 50, 100].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setQtyStr(String(n))}
              className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {n}
            </button>
          ))}
          {isBuy && pricePaiseValue > 0n && (
            <button
              type="button"
              disabled={maxBuyQty < 1n}
              onClick={() => setQtyStr(maxBuyQty.toString())}
              className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-gold transition-colors hover:border-gold/50 disabled:opacity-40"
            >
              Max
            </button>
          )}
        </div>
      </div>

      {/* Price */}
      {kind !== "MARKET" && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="price" className="text-xs font-medium text-muted-foreground">
              {kind === "LIMIT" ? "Limit price" : "Stop price"} (₹)
            </label>
            <span className="text-[10px] text-muted-foreground">
              tick ₹0.05 · multiples of 5 paise
            </span>
          </div>
          <Input
            id="price"
            inputMode="decimal"
            value={kind === "LIMIT" ? limitStr : stopStr}
            onChange={(e) =>
              kind === "LIMIT"
                ? setLimitStr(e.target.value)
                : setStopStr(e.target.value)
            }
            placeholder={`e.g. ${(Number(spot) / 100).toFixed(2)}`}
            className="tnum font-mono"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => fillFromSpot()}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Zap className="size-3" /> LTP
            </button>
            <button
              type="button"
              onClick={() => fillFromSpot(isBuy ? 5 : -5)}
              className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-up transition-colors hover:border-up/40"
            >
              +0.5%
            </button>
            <button
              type="button"
              onClick={() => fillFromSpot(isBuy ? -5 : 5)}
              className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-down transition-colors hover:border-down/40"
            >
              -0.5%
            </button>
            <span className="ml-auto self-center text-[10px] text-muted-foreground">
              {side === "SELL" && pendingSellQty > 0
                ? `OCO bracket — pairs with the resting ${pendingSellQty} qty sell (first trigger wins, other cancels)`
                : kind === "STOP"
                  ? side === "SELL"
                    ? "protects a long position"
                    : "enters above the market"
                  : "resting limit — fills when price reaches level"}
            </span>
          </div>
        </div>
      )}

      {/* Estimate */}
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <div className="flex justify-between">
          <span>
            {opensShort || intent === "ADD_SHORT"
              ? "Margin (2× notional"
              : "Est. " + (kind === "MARKET" ? "value @ LTP" : "value @ level")}
            {opensShort || intent === "ADD_SHORT" ? (kind === "MARKET" ? " @ LTP)" : " + headroom)") : ""}
          </span>
          <span className="tnum font-mono font-semibold text-foreground">
            {qty > 0
              ? formatINR(opensShort || intent === "ADD_SHORT" ? marginEstimate : notional)
              : "—"}
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span>P&L basis</span>
          <span>
            {coversShort
              ? "Realized on cover vs. short avg"
              : opensShort || intent === "ADD_SHORT"
                ? "Realized on cover; max loss ½ margin (auto-cover 2×)"
                : side === "SELL"
                  ? "Realized on fill vs. avg cost"
                  : "Unrealized while held"}
          </span>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-down/25 bg-down-bg px-3 py-2 text-[11px] leading-4 text-down">
          {error}
        </p>
      )}

      <Button
        type="button"
        disabled={busy || error !== null}
        onClick={submit}
        className={cn(
          "h-11 w-full text-sm font-bold tracking-wide",
          isBuy
            ? "bg-up text-[#03140c] hover:bg-up/90"
            : "bg-down text-[#1a0408] hover:bg-down/90",
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : buttonLabel}
      </Button>
      <p className="-mt-2 text-center text-[10px] text-muted-foreground">
        Server-authoritative fills · no leverage · intraday only · closes 00:00 IST roll
      </p>
    </section>
  );
}
