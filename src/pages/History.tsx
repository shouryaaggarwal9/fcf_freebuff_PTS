/**
 * History — full order history with server-side filters (status, type,
 * symbol) and client-side side filter. Sums the realized P&L of whatever is
 * filtered into view.
 */
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { TradingShell, PageHeader } from "@/components/trading/TradingShell";
import { useAuth } from "@/hooks/use-auth";
import { useReconcileLoop } from "@/hooks/use-reconcile-loop";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SYMBOLS } from "@/config/market";
import { formatINR, istDayLabel, istTimeLabel, signedINR } from "@/lib/format";
import { cn } from "@/lib/utils";
import { History as HistoryIcon } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router";

type OrderRow = Doc<"orders">;

const STATUSES = ["FILLED", "CANCELLED", "EXPIRED", "OPEN", "ALL"] as const;
const TYPES = ["ALL", "MARKET", "LIMIT", "STOP"] as const;
const SIDES = ["ALL", "BUY", "SELL"] as const;

function Empty() {
  return (
    <div className="flex flex-col items-center gap-2 border-t border-border px-4 py-14 text-center">
      <HistoryIcon className="size-4 text-muted-foreground/60" />
      <p className="max-w-sm text-[12px] leading-5 text-muted-foreground">
        No orders match this filter yet. Every placement — fills, day-end
        square-offs, cancellations and expiries — is recorded here.
      </p>
    </div>
  );
}

function statusBadge(o: OrderRow) {
  const map: Record<string, string> = {
    FILLED: "bg-up/15 text-up",
    CANCELLED: "bg-muted text-muted-foreground",
    EXPIRED: "bg-muted text-muted-foreground",
    OPEN: "bg-primary/15 text-primary",
  };
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold", map[o.status] ?? "bg-muted")}>
      {o.status}
    </span>
  );
}

export default function History() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  useReconcileLoop(isAuthenticated && !authLoading);
  const account = useQuery(api.market.getAccount);

  // Filters persist in the URL (?status=...&type=...&side=...&symbol=...).
  const [params, setParams] = useSearchParams();
  const status = STATUSES.includes(params.get("status") as never) ? (params.get("status") as string) : "FILLED";
  const type = TYPES.includes(params.get("type") as never) ? (params.get("type") as string) : "ALL";
  const side = SIDES.includes(params.get("side") as never) ? (params.get("side") as string) : "ALL";
  const symbol = SYMBOLS.some((d) => d.symbol === params.get("symbol")) ? params.get("symbol")! : "ALL";

  const setFilter = (key: string, value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };

  const all = useQuery(api.market.getOrders, {
    status: status === "ALL" ? undefined : status,
    orderType: type === "ALL" ? undefined : type,
    symbol: symbol === "ALL" ? undefined : symbol,
  });

  const rows = useMemo(() => {
    const list = all ?? [];
    return side === "ALL" ? list : list.filter((o) => o.side === side);
  }, [all, side]);

  const realizedTotal = useMemo(() => {
    let sum = 0n;
    for (const o of rows) {
      if (o.status === "FILLED") {
        // Realized P&L lives on closing fills: SELL exits of longs and BUY
        // covers of shorts (OPEN_SHORT sells carry none).
        if (
          (o.side === "SELL" && o.intent !== "OPEN_SHORT") ||
          (o.side === "BUY" && o.intent === "COVER_SHORT")
        )
          sum += o.realizedPnlPaise ?? 0n;
      }
    }
    return sum;
  }, [rows]);

  const filterChip = (label: string, keys: string[], activeKey: string, onPick: (v: string) => void) => (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onPick(k)}
          className={cn(
            "cursor-pointer rounded-md px-2 py-1 font-mono text-[11px] font-semibold transition-colors",
            activeKey === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label === "Side" && k === "ALL" ? "Both" : k === "ALL" ? "All" : k}
        </button>
      ))}
    </div>
  );

  return (
    <TradingShell
      active="history"
      cash={(account?.availableCashPaise ?? 0n) + (account?.marginBlockedPaise ?? 0n)}
    >
      <PageHeader
        title="Order history"
        sub="Every order you have placed, with historical fill prices and realized P&L as stored at fill time by the settlement engine."
        right={
          <span className="tnum rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-[12px] text-muted-foreground">
            {rows.length} orders · realized {signedINR(realizedTotal)}
          </span>
        }
      />

      {/* filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {filterChip("Status", [...STATUSES], status, (v) => setFilter("status", v))}
        {filterChip("Side", [...SIDES], side, (v) => setFilter("side", v))}
        {filterChip("Type", [...TYPES], type, (v) => setFilter("type", v))}
        <select
          value={symbol}
          onChange={(e) => setFilter("symbol", e.target.value)}
          className="cursor-pointer rounded-lg border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11px] font-semibold text-foreground outline-none"
        >
          <option value="ALL">All symbols</option>
          {SYMBOLS.map((d) => (
            <option key={d.symbol} value={d.symbol}>
              {d.symbol}
            </option>
          ))}
        </select>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        {all === undefined ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : rows.length === 0 ? (
          <Empty />
        ) : (
          <div className="scrollbar-thin max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Placed</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Level</TableHead>
                  <TableHead className="text-right">Fill ₹</TableHead>
                  <TableHead>Filled</TableHead>
                  <TableHead className="text-right">Realized P&L</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow key={o._id} className="hover:bg-muted/30">
                    <TableCell className="tnum whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                      {istDayLabel(o.createdMs)} {istTimeLabel(o.createdMs)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold",
                            o.side === "BUY" ? "bg-up/15 text-up" : "bg-down/15 text-down",
                          )}
                        >
                          {o.side}
                        </span>
                        <span className="font-mono text-[13px] font-bold">{o.symbol}</span>
                        <span className="rounded border border-border px-1 py-0 font-mono text-[9px] text-muted-foreground">
                          {o.orderType === "LIMIT" ? "LMT" : o.orderType === "STOP" ? "SL" : "MKT"}
                        </span>
                        {o.reason === "DAY_END" && (
                          <span className="text-[9px] font-semibold text-gold">sq-off</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="tnum text-right font-mono">{o.qty}</TableCell>
                    <TableCell className="tnum text-right font-mono text-muted-foreground">
                      {o.orderType === "LIMIT" && o.limitPaise !== undefined
                        ? formatINR(o.limitPaise)
                        : o.orderType === "STOP" && o.stopPaise !== undefined
                          ? formatINR(o.stopPaise)
                          : "—"}
                    </TableCell>
                    <TableCell className="tnum text-right font-mono">
                      {o.fillPricePaise !== undefined ? formatINR(o.fillPricePaise) : "—"}
                    </TableCell>
                    <TableCell className="tnum whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                      {o.fillEpochSec !== undefined
                        ? `${istDayLabel(o.fillEpochSec * 1000)} ${istTimeLabel(o.fillEpochSec * 1000)}`
                        : "—"}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "tnum text-right font-mono font-semibold",
                        (o.side === "SELL" && o.intent !== "OPEN_SHORT") ||
                        o.intent === "COVER_SHORT"
                          ? (o.realizedPnlPaise ?? 0n) >= 0n
                            ? "text-up"
                            : "text-down"
                          : "text-muted-foreground",
                      )}
                    >
                      {(o.side === "SELL" && o.intent !== "OPEN_SHORT") ||
                      o.intent === "COVER_SHORT"
                        ? signedINR(o.realizedPnlPaise ?? 0n)
                        : "—"}
                    </TableCell>
                    <TableCell>{statusBadge(o)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </TradingShell>
  );
}
