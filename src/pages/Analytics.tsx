/**
 * Analytics — automated trade analytics over the ledger and stored realized
 * P&L. All money math stays integer paise on the server; this page renders
 * the query result. Sharpe is annualized from daily returns and needs a
 * handful of active days before it means anything — the UI says so.
 */
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { TradingShell, PageHeader } from "@/components/trading/TradingShell";
import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatINR, istDayLabel, signedINR } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BarChart3 } from "lucide-react";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface AnalyticsData {
  grantPaise: bigint;
  currentEquityPaise: bigint;
  totalReturnPctBp: bigint;
  maxDrawdownPctBp: bigint;
  sharpe: number | null;
  days: { dayStartSec: number; equityPaise: bigint }[];
  nDays: number;
  bestDayPaise: bigint;
  worstDayPaise: bigint;
  trades: { symbol: string; dayStartSec: number; qty: number; pnlPaise: bigint }[];
  nTrades: number;
  wins: number;
  losses: number;
  flats: number;
  winRatePctBp: bigint;
  grossProfitPaise: bigint;
  grossLossPaise: bigint;
  avgWinPaise: bigint;
  avgLossPaise: bigint;
  largestWinPaise: bigint;
  largestLossPaise: bigint;
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3.5">
      <p className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className={cn("tnum mt-2 truncate font-mono text-lg font-bold tracking-tight", accent)}>
        {value}
      </p>
      {sub && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

const bp = (v: bigint) => (Number(v < 0n ? -v : v) / 100).toFixed(2);

export default function Analytics() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  void isAuthenticated;
  void authLoading;
  const account = useQuery(api.market.getAccount);
  const a = useQuery(api.market.getAnalytics) as AnalyticsData | null | undefined;

  const equitySeries = useMemo(() => {
    if (!a) return [];
    return a.days.map((d) => ({
      day: istDayLabel(d.dayStartSec * 1000),
      equity: Number(d.equityPaise) / 100,
    }));
  }, [a]);

  const profitFactor =
    a && a.grossLossPaise > 0n
      ? Number(a.grossProfitPaise) / Number(a.grossLossPaise)
      : a && a.grossProfitPaise > 0n
        ? Infinity
        : null;

  return (
    <TradingShell
      active="analytics"
      cash={(account?.availableCashPaise ?? 0n) + (account?.marginBlockedPaise ?? 0n)}
    >
      <PageHeader
        title="Trade analytics"
        sub="Automated performance statistics computed from your ledger and stored realized P&L. Equity is closing cash per UTC day; today is live (cash + holdings at LTP)."
      />

      {a === undefined ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : a === null ? (
        <p className="text-sm text-muted-foreground">Sign in to see analytics.</p>
      ) : (
        <>
          {/* headline stats */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Equity"
              value={formatINR(a.currentEquityPaise)}
              sub={`start ${formatINR(a.grantPaise)} · ${a.nDays} day${a.nDays === 1 ? "" : "s"}`}
            />
            <Stat
              label="Total return"
              value={`${a.totalReturnPctBp >= 0n ? "+" : "-"}${bp(a.totalReturnPctBp)}%`}
              accent={a.totalReturnPctBp >= 0n ? "text-up" : "text-down"}
              sub="since account opening"
            />
            <Stat
              label="Max drawdown"
              value={`${bp(a.maxDrawdownPctBp)}%`}
              accent={a.maxDrawdownPctBp > 0n ? "text-down" : undefined}
              sub="peak-to-trough, daily equity"
            />
            <Stat
              label="Sharpe (ann.)"
              value={a.sharpe === null ? "—" : a.sharpe.toFixed(2)}
              sub={
                a.sharpe === null
                  ? `needs ≥ 3 active days (${a.nDays} so far)`
                  : `${a.nDays} days · daily returns · 252×`
              }
            />
            <Stat
              label="Round trips"
              value={String(a.nTrades)}
              sub={`${a.wins}W · ${a.losses}L${a.flats > 0 ? ` · ${a.flats} flat` : ""}`}
            />
            <Stat
              label="Win rate"
              value={`${bp(a.winRatePctBp)}%`}
              sub="winning round trips / closed"
            />
            <Stat
              label="Avg win / loss"
              value={`${formatINR(a.avgWinPaise)} / ${formatINR(a.avgLossPaise)}`}
              sub={`largest ${signedINR(a.largestWinPaise)} / ${signedINR(-a.largestLossPaise)}`}
            />
            <Stat
              label="Profit factor"
              value={profitFactor === null ? "—" : profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}
              sub={`gross +${formatINR(a.grossProfitPaise)} · −${formatINR(a.grossLossPaise)}`}
            />
          </div>

          {/* equity curve */}
          <section className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                Equity curve
              </h2>
            </div>
            <div className="h-64 px-2 py-3">
              {equitySeries.length < 2 ? (
                <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
                  Trade for another day to draw your equity curve — one point per
                  UTC day.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={equitySeries} margin={{ top: 5, right: 12, bottom: 0, left: 8 }}>
                    <defs>
                      <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2fce8f" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#2fce8f" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(148,163,184,0.07)" />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 10, fill: "#8fa3bf" }}
                      tickLine={false}
                      axisLine={{ stroke: "rgba(148,163,184,0.16)" }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "#8fa3bf" }}
                      tickLine={false}
                      axisLine={false}
                      width={80}
                      tickFormatter={(v: number) =>
                        `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
                      }
                      domain={["auto", "auto"]}
                    />
                    <Tooltip
                      formatter={(value) => [
                        `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
                        "Equity",
                      ]}
                      contentStyle={{
                        background: "rgba(15,23,42,0.95)",
                        border: "1px solid rgba(148,163,184,0.2)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="equity"
                      stroke="#2fce8f"
                      strokeWidth={2}
                      fill="url(#eqFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
            <p className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
              Daily extremes: best {signedINR(a.bestDayPaise)} · worst{" "}
              {signedINR(a.worstDayPaise)}. Drawdown and Sharpe use daily closing
              equity — intraday dips are not captured.
            </p>
          </section>

          {/* round trips */}
          <section className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                <BarChart3 className="size-3.5" />
                Round trips
              </h2>
              <span className="text-[10px] text-muted-foreground">
                one row per (symbol, day) · partial exits aggregated
              </span>
            </div>
            {a.trades.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
                <BarChart3 className="size-4 text-muted-foreground/60" />
                <p className="max-w-sm text-[12px] leading-5 text-muted-foreground">
                  No closed trades yet. Sell fills record their realized P&L at
                  fill time; analytics aggregate them here automatically.
                </p>
              </div>
            ) : (
              <div className="scrollbar-thin max-h-[50vh] overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Day</TableHead>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="text-right">Qty sold</TableHead>
                      <TableHead className="text-right">Realized P&L</TableHead>
                      <TableHead className="text-right">Outcome</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {a.trades.map((t) => (
                      <TableRow key={`${t.symbol}:${t.dayStartSec}`} className="hover:bg-muted/30">
                        <TableCell className="tnum whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                          {istDayLabel(t.dayStartSec * 1000)}
                        </TableCell>
                        <TableCell className="font-mono text-[13px] font-bold">{t.symbol}</TableCell>
                        <TableCell className="tnum text-right font-mono">{t.qty}</TableCell>
                        <TableCell
                          className={cn(
                            "tnum text-right font-mono font-semibold",
                            t.pnlPaise >= 0n ? "text-up" : "text-down",
                          )}
                        >
                          {signedINR(t.pnlPaise)}
                        </TableCell>
                        <TableCell className="text-right">
                          <span
                            className={cn(
                              "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold",
                              t.pnlPaise > 0n
                                ? "bg-up/15 text-up"
                                : t.pnlPaise < 0n
                                  ? "bg-down/15 text-down"
                                  : "bg-muted text-muted-foreground",
                            )}
                          >
                            {t.pnlPaise > 0n ? "WIN" : t.pnlPaise < 0n ? "LOSS" : "FLAT"}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        </>
      )}
    </TradingShell>
  );
}
