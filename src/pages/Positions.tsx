/**
 * Positions — today's open intraday positions with live LTP, unrealized
 * P&L and a quick square-off (sell) action that prefills the terminal
 * ticket. Positions auto-expire at the day roll (server force-sells).
 */
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
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
import { formatINR, istTimeLabel, signedINR } from "@/lib/format";
import { positionMtm } from "@/lib/position";
import { cn } from "@/lib/utils";
import { Briefcase, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

type PositionRow = Doc<"positions">;

export default function Positions() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  useReconcileLoop(isAuthenticated && !authLoading);
  const navigate = useNavigate();
  const nowSec = useNowSec(3000); // keeps LTP/MTM live between query updates
  const account = useQuery(api.market.getAccount);
  const positions = useQuery(api.market.getPositions);
  const placeOrder = useMutation(api.market.placeOrder);
  const [squaring, setSquaring] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!positions) return [];
    return positions
      .map((p) => ({ ...p, ltp: pricePaise(p.symbol, BigInt(nowSec)) }))
      .sort((a, b) => {
        const av = positionMtm(a, a.ltp);
        const bv = positionMtm(b, b.ltp);
        return av === bv ? 0 : av > bv ? -1 : 1;
      });
  }, [positions, nowSec]);

  const holdingsValue = rows.reduce((s, p) => s + p.ltp * BigInt(p.qty), 0n);
  const unrealized = rows.reduce((s, p) => s + positionMtm(p, p.ltp), 0n);

  const squareOff = async (p: PositionRow) => {
    setSquaring(p._id);
    try {
      const res = await placeOrder({
        symbol: p.symbol,
        // Short positions square off by buying back; longs by selling.
        side: p.side === "SHORT" ? "BUY" : "SELL",
        orderType: "MARKET",
        qty: p.qty,
      });
      toast.success(res.message, {
        description:
          p.side === "SHORT"
            ? `Covered ${p.qty} ${p.symbol} at market`
            : `Sold ${p.qty} ${p.symbol} at market`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSquaring(null);
    }
  };

  // Headline cash: total, including margin blocked on open shorts.
  const cash = (account?.availableCashPaise ?? 0n) + (account?.marginBlockedPaise ?? 0n);

  return (
    <TradingShell active="positions" cash={cash}>
      <PageHeader
        title="Positions"
        sub="Today's intraday positions. Everything force-squares at the 00:00 UTC day roll — every day starts flat."
        right={
          <div className="flex items-center gap-2">
            <span className="tnum rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-[12px] text-muted-foreground">
              holdings {formatINR(holdingsValue)}
            </span>
            <span
              className={cn(
                "tnum rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-[12px] font-semibold",
                unrealized >= 0n ? "text-up" : "text-down",
              )}
            >
              MTM {signedINR(unrealized)}
            </span>
          </div>
        }
      />
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        {positions === undefined ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 border-t border-border px-4 py-14 text-center">
            <Briefcase className="size-4 text-muted-foreground/60" />
            <p className="max-w-sm text-[12px] leading-5 text-muted-foreground">
              No open positions. Buys fill instantly at market or rest as
              limit/stop orders until the deterministic market reaches your
              level.
            </p>
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={() => navigate("/dashboard")}>
              Go to terminal
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Side</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Avg cost ₹</TableHead>
                  <TableHead className="text-right">LTP ₹</TableHead>
                  <TableHead className="text-right">Value ₹</TableHead>
                  <TableHead className="text-right">Unrealized P&L</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => {
                  const pnl = positionMtm(p, p.ltp);
                  const isShort = p.side === "SHORT";
                  return (
                    <TableRow key={p._id} className="hover:bg-muted/30">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {p.side === "SHORT" ? (
                            <TrendingDown className="size-3.5 text-down" />
                          ) : (
                            <TrendingUp className="size-3.5 text-up" />
                          )}
                          <div>
                            <p className="font-mono text-[13px] font-bold">{p.symbol}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {isShort
                                ? `auto-cover 2× @ ${formatINR(2n * p.avgCostPaise)}`
                                : `opened ${istTimeLabel(p.createdMs)} IST`}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tnum text-right font-mono text-[11px] font-semibold",
                          p.side === "SHORT" ? "text-down" : "text-up",
                        )}
                      >
                        {p.side === "SHORT" ? "SHORT" : "LONG"}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono">{p.qty}</TableCell>
                      <TableCell className="tnum text-right font-mono">{formatINR(p.avgCostPaise)}</TableCell>
                      <TableCell className="tnum text-right font-mono text-muted-foreground">{formatINR(p.ltp)}</TableCell>
                      <TableCell className="tnum text-right font-mono">{formatINR(p.ltp * BigInt(p.qty))}</TableCell>
                      <TableCell
                        className={cn(
                          "tnum text-right font-mono font-semibold",
                          pnl >= 0n ? "text-up" : "text-down",
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
                          disabled={squaring === p._id}
                          onClick={() => void squareOff(p)}
                        >
                          {squaring === p._id
                            ? p.side === "SHORT" ? "Covering…" : "Selling…"
                            : p.side === "SHORT" ? "Cover" : "Square off"}
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
