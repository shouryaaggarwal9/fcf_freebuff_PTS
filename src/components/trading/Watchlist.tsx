/**
 * Watchlist — live spot quotes + day change for the 10 frozen NSE symbols.
 * Purely display: prices come from the deterministic engine evaluated at the
 * browser clock second. Fills are never derived from this.
 */
import { SYMBOLS } from "@/config/market";
import { dayStartSec, lastTickSecOfDay, pricePaise } from "@/engine/price";
import { cn } from "@/lib/utils";

interface WatchlistProps {
  nowSec: number;
  activeSymbol: string;
  onSelect: (symbol: string) => void;
  /** Optional qty-per-symbol badge (today's holdings). */
  holdings?: Map<string, number>;
  className?: string;
}

function dayDelta(symbol: string, nowSec: number): {
  prevClose: bigint;
  change: bigint;
  pct: bigint;
} {
  const dayStart = dayStartSec(BigInt(nowSec));
  const prevClose = pricePaise(symbol, dayStart - 1n);
  const spot = pricePaise(symbol, BigInt(nowSec));
  const change = spot - prevClose;
  // percentage × 100 (percent-hundredths), bigint only; display divides by 100
  const pct = prevClose === 0n ? 0n : (change * 10_000n) / prevClose;
  return { prevClose, change, pct };
}

export function Watchlist({
  nowSec,
  activeSymbol,
  onSelect,
  holdings,
  className,
}: WatchlistProps) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h3 className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          Watchlist
        </h3>
        <span className="flex items-center gap-1.5 text-[10px] font-medium text-up">
          <span className="size-1.5 animate-pulse rounded-full bg-up" />
          LIVE
        </span>
      </div>
      <ul className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2">
        {SYMBOLS.map((def) => {
          const spot = pricePaise(def.symbol, BigInt(nowSec));
          const { change, pct } = dayDelta(def.symbol, nowSec);
          const up = change >= 0n;
          const held = holdings?.get(def.symbol) ?? 0;
          const active = def.symbol === activeSymbol;
          return (
            <li key={def.symbol}>
              <button
                type="button"
                onClick={() => onSelect(def.symbol)}
                className={cn(
                  "group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-accent/60",
                  active &&
                    "border-primary/25 bg-primary/10 hover:bg-primary/10",
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "h-7 w-1 rounded-full",
                      up ? "bg-up/70" : "bg-down/70",
                    )}
                  />
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "truncate font-mono text-[13px] font-bold tracking-tight",
                        active && "text-primary",
                      )}
                    >
                      {def.symbol}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {def.label}
                      {held > 0 && (
                        <span className="ml-1 text-gold">· {held} held</span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="tnum font-mono text-[13px] font-semibold">
                    ₹{(Number(spot) / 100).toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </p>
                  <p
                    className={cn(
                      "tnum font-mono text-[11px] font-medium",
                      up ? "text-up" : "text-down",
                    )}
                  >
                    {up ? "+" : "-"}
                    {(Number(pct < 0n ? -pct : pct) / 100).toFixed(2)}%
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
