/**
 * Orders — all working (OPEN) orders across symbols, with server
 * reconciliation on open and manual cancel. The server remains the sole
 * authority: cancel first reconciles, so a due order fills instead of
 * cancelling.
 */
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { TradingShell, PageHeader } from "@/components/trading/TradingShell";
import { useAuth } from "@/hooks/use-auth";
import { useNowSec } from "@/hooks/use-now-sec";
import { useReconcileLoop } from "@/hooks/use-reconcile-loop";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { pricePaise } from "@/engine/price";
import { formatINR, istTimeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ClipboardList, Loader2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type OrderRow = Doc<"orders">;

const EMPTY = { icon: <ClipboardList className="size-4" />, text: "" };

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 border-t border-border px-4 py-14 text-center">
      <span className="text-muted-foreground/60">{icon}</span>
      <p className="max-w-sm text-[12px] leading-5 text-muted-foreground">{text}</p>
    </div>
  );
}

function typeLabel(o: OrderRow): string {
  if (o.orderType === "LIMIT") return "LMT";
  if (o.orderType === "STOP") return "SL";
  return "MKT";
}

function levelLabel(o: OrderRow): string {
  if (o.orderType === "LIMIT" && o.limitPaise !== undefined) return formatINR(o.limitPaise);
  if (o.orderType === "STOP" && o.stopPaise !== undefined) return formatINR(o.stopPaise);
  return "—";
}

function sideBadge(side: string) {
  const buy = side === "BUY";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold",
        buy ? "bg-up/15 text-up" : "bg-down/15 text-down",
      )}
    >
      {side}
    </span>
  );
}

export default function Orders() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  useReconcileLoop(isAuthenticated && !authLoading);
  const nowSec = useNowSec(3000); // keeps the LTP column live
  const orders = useQuery(api.market.getOrders, { status: "OPEN" });
  const account = useQuery(api.market.getAccount);
  const cancelOrder = useMutation(api.market.cancelOrder);
  const [canceling, setCanceling] = useState<Id<"orders"> | null>(null);

  const rows = orders ?? [];
  // Headline cash: total, including margin blocked on open shorts.
  const cash = (account?.availableCashPaise ?? 0n) + (account?.marginBlockedPaise ?? 0n);
  const reserved = rows.reduce(
    (s, o) => s + (o.side === "BUY" ? o.reservedCashPaise : 0n),
    0n,
  );

  const handleCancel = async (orderId: Id<"orders">) => {
    setCanceling(orderId);
    try {
      const res = await cancelOrder({ orderId });
      toast.success(res.message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCanceling(null);
    }
  };

  return (
    <TradingShell active="orders" cash={cash}>
      <PageHeader
        title="Open orders"
        sub="Resting limit and stop orders across all symbols. Fills are settled server-side the moment the deterministic market touches your level."
        right={
          <span className="tnum rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-[12px] text-muted-foreground">
            {rows.length} working · {formatINR(reserved)} cash reserved
          </span>
        }
      />
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        {orders === undefined ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            icon={EMPTY.icon}
            text="No working orders. Limit and stop orders you place rest here until the market touches the level, the day ends, or you cancel them."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Placed</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Level</TableHead>
                  <TableHead className="text-right">LTP</TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => {
                  const ltp = pricePaise(o.symbol, BigInt(nowSec));
                  return (
                    <TableRow key={o._id} className="hover:bg-muted/30">
                      <TableCell className="tnum whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                        {istTimeLabel(o.createdMs)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {sideBadge(o.side)}
                          <span className="font-mono text-[13px] font-bold">{o.symbol}</span>
                          <span className="rounded border border-border px-1 py-0 font-mono text-[9px] text-muted-foreground">
                            {typeLabel(o)}
                          </span>
                          {o.ocoId && (
                            <span className="rounded border border-gold/40 px-1 py-0 font-mono text-[9px] font-semibold text-gold">
                              OCO
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="tnum text-right font-mono">{o.qty}</TableCell>
                      <TableCell className="tnum text-right font-mono">{levelLabel(o)}</TableCell>
                      <TableCell className="tnum text-right font-mono text-muted-foreground">
                        {formatINR(ltp)}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono text-gold">
                        {o.side === "BUY" ? formatINR(o.reservedCashPaise) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1 px-2 text-[11px] hover:text-destructive"
                          disabled={canceling === o._id}
                          onClick={() => void handleCancel(o._id)}
                        >
                          {canceling === o._id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <X className="size-3" />
                          )}
                          Cancel
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </TradingShell>
  );
}
