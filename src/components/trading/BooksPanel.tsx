/**
 * BooksPanel — Positions · Open orders · History · Ledger.
 * All rows are read from Convex server state (reactive queries); money shown
 * is always integer paise formatted for display, and realized P&L values are
 * read back from the stored fill records, never recomputed client-side.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { pricePaise } from "@/engine/price";
import { cn } from "@/lib/utils";
import { formatINR, istTimeLabel, signedINR } from "@/lib/format";
import {
  Archive,
  BookOpenText,
  History,
  Loader2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

type OrderRow = Doc<"orders">;
type PositionRow = Doc<"positions">;
type LedgerRow = Doc<"ledger">;

interface BooksPanelProps {
  nowSec: number;
  positions: PositionRow[];
  orders: OrderRow[] | undefined;
  ledger: LedgerRow[] | undefined;
  cancelOrder: (orderId: Id<"orders">) => Promise<void>;
  onSell: (position: PositionRow) => void;
  className?: string;
}

const SIDE_STYLE: Record<string, string> = {
  BUY: "text-up bg-up-bg border-up/30",
  SELL: "text-down bg-down-bg border-down/30",
};

const ENTRY_LABEL: Record<string, string> = {
  deposit: "Opening deposit",
  buy_fill: "Buy fill",
  sell_fill: "Sell fill",
  reserve: "Cash reserved",
  reserve_release: "Reserve released",
};

function Empty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="grid size-10 place-items-center rounded-full border border-border text-muted-foreground/70">
        {icon}
      </div>
      <p className="max-w-xs text-xs leading-5 text-muted-foreground">{text}</p>
    </div>
  );
}

function statusBadge(status: string, reason?: string) {
  const styles: Record<string, string> = {
    OPEN: "border-primary/30 bg-primary/10 text-primary",
    FILLED: "border-up/30 bg-up-bg text-up",
    CANCELLED: "border-border bg-muted text-muted-foreground",
    EXPIRED: "border-gold/30 bg-gold/10 text-gold",
  };
  const label =
    status === "EXPIRED"
      ? reason === "DAY_END"
        ? "Expired · day end"
        : "Expired"
      : status === "FILLED"
        ? reason === "DAY_END"
          ? "Auto sq-off"
          : "Filled"
        : status === "CANCELLED"
          ? "Cancelled"
          : "Working";
  return (
    <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px] font-semibold", styles[status] ?? "")}>
      {label}
    </Badge>
  );
}

function orderSide(side: string) {
  return (
    <span
      className={cn(
        "inline-block rounded border px-1.5 py-0 font-mono text-[10px] font-bold",
        SIDE_STYLE[side],
      )}
    >
      {side === "BUY" ? "B" : "S"}
    </span>
  );
}

function typeLabel(orderType: string) {
  if (orderType === "MARKET") return "Mkt";
  if (orderType === "LIMIT") return "Lmt";
  return "SL";
}

function levelLabel(order: OrderRow): string {
  if (order.orderType === "LIMIT") return `@ ${formatINR(order.limitPaise ?? 0n)}`;
  if (order.orderType === "STOP") return `@ ${formatINR(order.stopPaise ?? 0n)}`;
  return "—";
}

function dayStartOfSec(sec: number): number {
  return Math.floor(sec / 86400) * 86400;
}

export function BooksPanel({
  nowSec,
  positions,
  orders,
  ledger,
  cancelOrder,
  onSell,
  className,
}: BooksPanelProps) {
  const todayStart = dayStartOfSec(nowSec);
  const openOrders = (orders ?? []).filter((o) => o.status === "OPEN");
  const history = (orders ?? [])
    .filter((o) => o.status !== "OPEN")
    .slice(0, 60);
  const ledgerRows = (ledger ?? []).slice(0, 60);

  return (
    <Tabs defaultValue="positions" className={cn("flex flex-col", className)}>
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="positions">Positions</TabsTrigger>
        <TabsTrigger value="orders">Open orders</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
        <TabsTrigger value="ledger">Ledger</TabsTrigger>
      </TabsList>

      {/* ------------------------------- Positions ------------------------------ */}
      <TabsContent value="positions" className="mt-0">
        {positions.length === 0 ? (
          <Empty
            icon={<BookOpenText className="size-4" />}
            text="No open positions today. Buy any of the 10 NSE symbols — everything is force-squared at the day rollover (00:00 UTC)."
          />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Avg ₹</TableHead>
                  <TableHead className="text-right">LTP ₹</TableHead>
                  <TableHead className="text-right">Value ₹</TableHead>
                  <TableHead className="text-right">Unrealized P&L</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => {
                  const ltp = pricePaise(p.symbol, BigInt(nowSec));
                  const pnl = (ltp - p.avgCostPaise) * BigInt(p.qty);
                  const value = ltp * BigInt(p.qty);
                  const up = pnl >= 0n;
                  return (
                    <TableRow key={p._id} className="hover:bg-muted/30">
                      <TableCell>
                        <span className="font-mono text-[13px] font-bold">
                          {p.symbol}
                        </span>
                        <span className="ml-2 text-[10px] text-muted-foreground">
                          intraday
                        </span>
                      </TableCell>
                      <TableCell className="tnum text-right font-mono">
                        {p.qty}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono">
                        {formatINR(p.avgCostPaise)}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono">
                        {formatINR(ltp)}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono">
                        {formatINR(value)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tnum text-right font-mono font-semibold",
                          up ? "text-up" : "text-down",
                        )}
                      >
                        {signedINR(pnl)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 border-down/30 px-2 text-[11px] text-down hover:bg-down/10 hover:text-down"
                          onClick={() => onSell(p)}
                        >
                          Sell
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <p className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
              One position row per (symbol, day) · auto square-off at day end ·
              today {todayStart === dayStartOfSec(nowSec) ? "started flat" : ""}
            </p>
          </div>
        )}
      </TabsContent>

      {/* ------------------------------ Open orders ----------------------------- */}
      <TabsContent value="orders" className="mt-0">
        {openOrders.length === 0 ? (
          <Empty
            icon={<Archive className="size-4" />}
            text="No working orders. Limit and stop orders rest here until their trigger price is touched by the deterministic market."
          />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Time</TableHead>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Level</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openOrders.map((o) => (
                  <TableRow key={o._id} className="hover:bg-muted/30">
                    <TableCell className="tnum whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                      {istTimeLabel(o.createdMs)}
                    </TableCell>
                    <TableCell>
                      {orderSide(o.side)}{" "}
                      <span className="ml-1.5 font-mono text-[13px] font-bold">
                        {o.symbol}
                      </span>
                      <span className="ml-1.5 rounded border border-border px-1 py-0 font-mono text-[9px] text-muted-foreground">
                        {typeLabel(o.orderType)}
                      </span>
                      {o.ocoId && (
                        <span className="ml-1.5 rounded border border-gold/40 px-1 py-0 font-mono text-[9px] font-semibold text-gold">
                          OCO
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tnum text-right font-mono">
                      {o.qty}
                    </TableCell>
                    <TableCell className="tnum text-right font-mono">
                      {levelLabel(o)}
                    </TableCell>
                    <TableCell>{statusBadge(o.status, o.reason)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                        onClick={() => void cancelOrder(o._id)}
                      >
                        <X className="size-3" />
                        Cancel
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TabsContent>

      {/* -------------------------------- History ------------------------------- */}
      <TabsContent value="history" className="mt-0">
        {history.length === 0 ? (
          <Empty
            icon={<History className="size-4" />}
            text="Your executed and expired orders will appear here with their historical fill prices and realized P&L."
          />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Filled / closed</TableHead>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Fill price ₹</TableHead>
                  <TableHead className="text-right">Realized P&L</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((o) => {
                  const fillSec = o.fillEpochSec ?? o.createdMs / 1000;
                  const realized =
                    o.status === "FILLED" &&
                    ((o.side === "SELL" && o.intent !== "OPEN_SHORT") ||
                      o.intent === "COVER_SHORT")
                      ? (o.realizedPnlPaise ?? 0n)
                      : null;
                  return (
                    <TableRow key={o._id} className="hover:bg-muted/30">
                      <TableCell className="tnum whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                        {istTimeLabel(fillSec)}
                      </TableCell>
                      <TableCell>
                        {orderSide(o.side)}{" "}
                        <span className="ml-1.5 font-mono text-[13px] font-bold">
                          {o.symbol}
                        </span>
                        <span className="ml-1.5 rounded border border-border px-1 py-0 font-mono text-[9px] text-muted-foreground">
                          {typeLabel(o.orderType)}
                        </span>
                        {o.ocoId && (
                          <span className="ml-1.5 rounded border border-gold/40 px-1 py-0 font-mono text-[9px] font-semibold text-gold">OCO</span>
                        )}
                        {o.reason === "DAY_END" && (
                          <span className="ml-1.5 text-[9px] text-gold">
                            sq-off
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono">
                        {o.qty}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono">
                        {o.fillPricePaise !== undefined
                          ? formatINR(o.fillPricePaise)
                          : "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tnum text-right font-mono font-semibold",
                          realized === null
                            ? "text-muted-foreground"
                            : realized >= 0n
                              ? "text-up"
                              : "text-down",
                        )}
                      >
                        {realized === null ? "—" : signedINR(realized)}
                      </TableCell>
                      <TableCell>{statusBadge(o.status, o.reason)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </TabsContent>

      {/* -------------------------------- Ledger -------------------------------- */}
      <TabsContent value="ledger" className="mt-0">
        {ledgerRows.length === 0 ? (
          <Empty
            icon={<Loader2 className="size-4 animate-spin" />}
            text="Loading your cash ledger…"
          />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Time (IST)</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledgerRows.map((row) => {
                  const isDeposit = row.entryType === "deposit";
                  const isRelease = row.entryType === "reserve_release";
                  const positive =
                    row.amountPaise > 0n || isRelease;
                  return (
                    <TableRow key={row._id} className="hover:bg-muted/30">
                      <TableCell className="tnum whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                        {istTimeLabel(row.timeMs)}
                      </TableCell>
                      <TableCell className="text-[12px]">
                        {ENTRY_LABEL[row.entryType] ?? row.entryType}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tnum text-right font-mono font-semibold",
                          row.entryType === "buy_fill" ||
                            row.entryType === "reserve"
                            ? "text-down"
                            : positive
                              ? "text-up"
                              : "text-down",
                        )}
                      >
                        {isDeposit
                          ? `+${formatINR(row.amountPaise)}`
                          : isRelease
                            ? `+${formatINR(row.amountPaise)}`
                            : row.amountPaise > 0n
                              ? `+${formatINR(row.amountPaise)}`
                              : formatINR(row.amountPaise)}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono text-muted-foreground">
                        {formatINR(
                          "runningBalancePaise" in row
                            ? (row as unknown as { runningBalancePaise: bigint })
                                .runningBalancePaise
                            : 0n,
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {ledger && ledger.length > ledgerRows.length && (
              <p className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
                Showing latest {ledgerRows.length} of {ledger.length} entries.
              </p>
            )}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

