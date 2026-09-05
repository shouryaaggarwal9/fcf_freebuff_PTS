/**
 * NSE Paper Trade Pro — trading terminal (/dashboard, auth-protected).
 *
 * Data flow:
 *  - Display market data (watchlist, chart, LTP) is rendered by the browser
 *    engine from the deterministic price function at the client clock second
 *    (the engine is allowed to run only in the browser).
 *  - The Convex backend is the sole authority for fills, time and money.
 *    placeOrder/cancelOrder/reconcileUser take no price/time from the client.
 *  - A 20 s reconcile loop + visibility-change reconcile + the daily cron
 *    backstop settle resting orders while the tab is open, when it regains
 *    focus, and for abandoned accounts.
 */
import { useAuth } from "@/hooks/use-auth";
import { useNowSec } from "@/hooks/use-now-sec";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { SESSIONS, SYMBOLS } from "@/config/market";
import {
  candleSeries,
  extendLiveSeries,
  type TimeframeSec,
} from "@/engine/candles";
import type { Candle } from "@/engine/model";
import { dayStartSec, pricePaise } from "@/engine/price";
import { errorMessage, formatINR, istTimeFull, istDayName, signedINR } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Brand } from "@/components/brand";
import { CandleChart } from "@/components/trading/CandleChart";
import { BooksPanel } from "@/components/trading/BooksPanel";
import { OrderTicket, type TicketPrefill } from "@/components/trading/OrderTicket";
import { Watchlist } from "@/components/trading/Watchlist";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  Banknote,
  CandlestickChart,
  LogOut,
  TimerReset,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

const DAY_SEC = 86_400;
const BAR_WINDOW: Record<number, number> = { 60: 240, 300: 160, 900: 70 };
const TIMEFRAMES: { label: string; sec: TimeframeSec }[] = [
  { label: "1m", sec: 60 },
  { label: "5m", sec: 300 },
  { label: "15m", sec: 900 },
];

type PositionRow = Doc<"positions">;

function dayStartOfSec(sec: number): number {
  return Math.floor(sec / DAY_SEC) * DAY_SEC;
}

export default function Dashboard() {
  const { isAuthenticated, isLoading: authLoading, user, signOut } = useAuth();
  const navigate = useNavigate();
  const nowSec = useNowSec(1000);

  const account = useQuery(api.market.getAccount);
  const positions = useQuery(api.market.getPositions);
  const orders = useQuery(api.market.getOrders, {});
  const ledger = useQuery(api.market.getLedger);
  const placeOrder = useMutation(api.market.placeOrder);
  const cancelOrder = useMutation(api.market.cancelOrder);
  const registerAndFund = useMutation(api.market.registerAndFund);
  const reconcileUser = useMutation(api.market.reconcileUser);

  const [activeSymbol, setActiveSymbol] = useState(SYMBOLS[0].symbol);
  const [tfSec, setTfSec] = useState<TimeframeSec>(60);
  const [prefill, setPrefill] = useState<TicketPrefill | null>(null);
  const [fundError, setFundError] = useState<string | null>(null);
  const fundedRef = useRef(false);

  /* ------------- one-time funding + periodic settlement ------------- */
  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    if (account === undefined) return; // query still loading
    if (account !== null || fundedRef.current) return;
    fundedRef.current = true;
    registerAndFund()
      .then(() => toast.success("Virtual account funded with ₹10,00,000"))
      .catch((err: unknown) => {
        setFundError(errorMessage(err));
      });
  }, [authLoading, isAuthenticated, account, registerAndFund]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const run = () => {
      reconcileUser().catch((err: unknown) => {
        console.warn("[reconcile]", errorMessage(err));
      });
    };
    run();
    const id = window.setInterval(run, 20_000);
    const onVisibility = () => {
      if (!document.hidden) run();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isAuthenticated, reconcileUser]);

  /* ---------------------------- derived data ---------------------------- */
  const cash = account?.availableCashPaise ?? 0n;
  const todayStart = dayStartOfSec(nowSec);
  const dayEndSec = dayStartOfSec(nowSec) + DAY_SEC;

  const holdingsBySymbol = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of positions ?? []) map.set(p.symbol, p.qty);
    return map;
  }, [positions]);

  const positionRows = useMemo(() => {
    if (!positions) return [];
    return positions
      .map((p) => ({ ...p, ltp: pricePaise(p.symbol, BigInt(nowSec)) }))
      .sort((a, b) => {
        const av = (a.ltp - a.avgCostPaise) * BigInt(a.qty);
        const bv = (b.ltp - b.avgCostPaise) * BigInt(b.qty);
        return av === bv ? 0 : av > bv ? -1 : 1;
      });
  }, [positions, nowSec]);

  const holdingsValue = useMemo(
    () =>
      positionRows.reduce((sum, p) => sum + p.ltp * BigInt(p.qty), 0n),
    [positionRows],
  );
  const unrealized = useMemo(
    () =>
      positionRows.reduce(
        (sum, p) => sum + (p.ltp - p.avgCostPaise) * BigInt(p.qty),
        0n,
      ),
    [positionRows],
  );
  const realizedToday = useMemo(() => {
    let sum = 0n;
    for (const o of orders ?? []) {
      if (
        o.dayStartSec === todayStart &&
        o.status === "FILLED" &&
        o.side === "SELL"
      ) {
        sum += o.realizedPnlPaise ?? 0n;
      }
    }
    return sum;
  }, [orders, todayStart]);

  /* ------------------------- live candle series ------------------------- */
  const liveRef = useRef<{
    symbol: string;
    tf: number;
    endSec: number;
    bars: Candle[];
  } | null>(null);
  const candles = useMemo(() => {
    const maxBars = BAR_WINDOW[tfSec] ?? 240;
    const cur = liveRef.current;
    if (!cur || cur.symbol !== activeSymbol || cur.tf !== tfSec) {
      const bars = candleSeries(activeSymbol, nowSec, tfSec, maxBars);
      liveRef.current = { symbol: activeSymbol, tf: tfSec, endSec: nowSec, bars };
      return bars;
    }
    const next = extendLiveSeries(
      activeSymbol,
      cur.bars,
      cur.endSec,
      nowSec,
      tfSec,
      maxBars,
    );
    liveRef.current = {
      symbol: activeSymbol,
      tf: tfSec,
      endSec: next.endSec,
      bars: next.candles,
    };
    return next.candles;
  }, [activeSymbol, nowSec, tfSec]);

  /* ------------------------------ handlers ------------------------------ */
  const handleSignOut = async () => {
    try {
      await signOut();
    } finally {
      navigate("/");
    }
  };

  const handlePlace = async (args: Parameters<typeof placeOrder>[0]) => {
    try {
      const res = await placeOrder(args);
      toast.success(res.message, { description: `${args.side} ${args.qty} ${args.symbol}` });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleCancel = async (orderId: Id<"orders">) => {
    try {
      const res = await cancelOrder({ orderId });
      toast.success(res.message);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const sellPosition = (p: PositionRow) => {
    setActiveSymbol(p.symbol);
    setPrefill({ symbol: p.symbol, side: "SELL", qty: p.qty });
    if (window.innerWidth < 1024) {
      document
        .getElementById("order-ticket")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  /* ------------------------------- render ------------------------------- */
  if (authLoading) {
    return (
      <FullScreenMsg>
        <span className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        Authenticating…
      </FullScreenMsg>
    );
  }
  if (account === undefined || account === null) {
    return (
      <FullScreenMsg>
        <span className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        {fundError ?? "Opening your ₹10,00,000 virtual account…"}
      </FullScreenMsg>
    );
  }

  const activeDef = SYMBOLS.find((d) => d.symbol === activeSymbol) ?? SYMBOLS[0];
  const spot = pricePaise(activeSymbol, BigInt(nowSec));
  const prevClose = pricePaise(activeSymbol, BigInt(dayStartSec(BigInt(nowSec))) - 1n);
  const spotChange = spot - prevClose;
  const spotUp = spotChange >= 0n;
  const spotPct = prevClose === 0n ? 0n : (spotChange * 10_000n) / prevClose;
  const equity = cash + holdingsValue;
  const dayPnl = realizedToday + unrealized;
  const session = SESSIONS[0];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="lg:flex">
        {/* ------------------------------ Sidebar ----------------------------- */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground lg:flex">
          <button
            type="button"
            className="flex cursor-pointer items-center px-5 py-5"
            onClick={() => navigate("/")}
          >
            <Brand />
          </button>
          <nav className="px-3">
            <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-[13px] font-semibold text-primary">
              <CandlestickChart className="size-4" />
              Terminal
            </div>
          </nav>
          <div className="flex-1" />
          <div className="mx-3 mb-3 rounded-lg border border-border/80 bg-muted/40 px-3 py-2.5">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1.5 font-semibold tracking-wide uppercase">
                <span className="size-1.5 animate-pulse rounded-full bg-up" />
                {session.name}
              </span>
              <span className="tnum font-mono">{istTimeFull(nowSec * 1000)} IST</span>
            </div>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              {session.label} · day roll 05:30 IST (00:00 UTC)
            </p>
            <p className="tnum mt-1 font-mono text-[10px] text-gold">
              {istDayName(nowSec * 1000)}
            </p>
          </div>
          <div className="border-t border-border px-5 py-4">
            <p className="truncate text-xs font-medium">
              {user?.name ?? user?.email ?? "Trader"}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 h-8 w-full justify-start gap-2 px-0 text-muted-foreground hover:text-foreground"
              onClick={handleSignOut}
            >
              <LogOut className="size-3.5" />
              Sign out
            </Button>
          </div>
        </aside>

        {/* ------------------------------ Main ------------------------------ */}
        <div className="min-w-0 flex-1">
          {/* mobile top bar */}
          <div className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-background/90 px-4 py-3 backdrop-blur lg:hidden">
            <button type="button" onClick={() => navigate("/")} className="cursor-pointer">
              <Brand />
            </button>
            <div className="flex items-center gap-2">
              <span className="tnum rounded-md border border-border bg-muted px-2 py-1 font-mono text-[11px] font-semibold">
                {formatINR(cash)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8"
                onClick={handleSignOut}
              >
                <LogOut className="size-4" />
              </Button>
            </div>
          </div>

          <div className="mx-auto w-full max-w-[1560px] px-4 py-4 sm:px-5 lg:px-6 lg:py-6">
            {/* account summary */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                icon={<Wallet className="size-4" />}
                label="Available cash"
                value={formatINR(cash)}
                sub="Buying power"
                accent="text-gold"
              />
              <StatCard
                icon={<Banknote className="size-4" />}
                label="Holdings value"
                value={formatINR(holdingsValue)}
                sub={
                  positionRows.length === 0
                    ? "No open positions"
                    : `${positionRows.reduce((n, p) => n + p.qty, 0)} shares today`
                }
              />
              <StatCard
                icon={<TrendingUp className="size-4" />}
                label="Unrealized P&L"
                value={signedINR(unrealized)}
                sub="Open positions"
                accent={unrealized >= 0n ? "text-up" : "text-down"}
              />
              <StatCard
                icon={<Activity className="size-4" />}
                label="Realized today"
                value={signedINR(realizedToday)}
                sub={`Day P&L ${signedINR(dayPnl)}`}
                accent={realizedToday >= 0n ? "text-up" : "text-down"}
              />
            </div>

            {/* chart + ticket */}
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_336px]">
              {/* chart */}
              <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2.5">
                      <h1 className="font-mono text-lg font-bold tracking-tight">
                        {activeSymbol}
                      </h1>
                      <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
                        {activeDef.label} · NSE
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span className="tnum font-mono text-xl font-bold tracking-tight">
                        {formatINR(spot)}
                      </span>
                      <span
                        className={cn(
                          "tnum font-mono text-[12px] font-semibold",
                          spotUp ? "text-up" : "text-down",
                        )}
                      >
                        {signedINR(spotChange)}
                      </span>
                      <span
                        className={cn(
                          "tnum font-mono text-[12px] font-semibold",
                          spotUp ? "text-up" : "text-down",
                        )}
                      >
                        {spotUp ? "+" : "-"}
                        {(Number(spotPct < 0n ? -spotPct : spotPct) / 100).toFixed(2)}%
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        Prev close {formatINR(prevClose)}
                      </span>
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <div className="flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
                      {TIMEFRAMES.map((t) => (
                        <button
                          key={t.sec}
                          type="button"
                          onClick={() => setTfSec(t.sec)}
                          className={cn(
                            "rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors",
                            tfSec === t.sec
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                    <span className="hidden items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[10px] font-semibold tracking-wide text-up uppercase sm:flex">
                      <span className="size-1.5 animate-pulse rounded-full bg-up" />
                      {istTimeFull(nowSec * 1000)}
                    </span>
                  </div>
                </div>
                <CandleChart symbol={activeSymbol} candles={candles} height={430} />
              </section>

              {/* order ticket */}
              <section
                id="order-ticket"
                className="scroll-mt-20 rounded-xl border border-border bg-card px-4 py-4"
              >
                <OrderTicket
                  symbol={activeSymbol}
                  onSymbolChange={setActiveSymbol}
                  nowSec={nowSec}
                  availableCashPaise={cash}
                  heldQty={holdingsBySymbol.get(activeSymbol) ?? 0}
                  onPlace={handlePlace}
                  prefill={prefill}
                  className="min-h-[520px]"
                />
              </section>
            </div>

            {/* books + watchlist */}
            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_272px]">
              <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
                <BooksPanel
                  nowSec={nowSec}
                  positions={positions ?? []}
                  orders={orders}
                  ledger={ledger}
                  cancelOrder={handleCancel}
                  onSell={sellPosition}
                />
              </section>
              <section className="hidden min-h-0 overflow-hidden rounded-xl border border-border bg-card xl:flex xl:max-h-[560px] xl:flex-col">
                <Watchlist
                  nowSec={nowSec}
                  activeSymbol={activeSymbol}
                  onSelect={(s) => {
                    setActiveSymbol(s);
                    setPrefill(null);
                  }}
                  holdings={holdingsBySymbol}
                  className="h-full"
                />
              </section>
            </div>

            {/* compact watchlist for smaller screens */}
            <div className="mt-4 xl:hidden">
              <MobileWatchStrip
                nowSec={nowSec}
                activeSymbol={activeSymbol}
                onSelect={setActiveSymbol}
              />
            </div>

            <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-[10px] text-muted-foreground">
              <p>
                <TimerReset className="mr-1 inline size-3" />
                Deterministic synthetic market — price is a pure function of
                (symbol, UTC second). Server-authoritative fills. Demo only; no
                real money, no real market data.
              </p>
              <p className="tnum font-mono">
                cash {formatINR(cash)} · equity {formatINR(equity)} · roll{" "}
                {istTimeFull(dayEndSec * 1000)} IST
              </p>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ sub components ------------------------------ */

function FullScreenMsg({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span className="text-primary">{icon}</span>
        <span className="text-[10px] font-semibold tracking-[0.12em] uppercase">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "tnum mt-2 truncate font-mono text-lg font-bold tracking-tight",
          accent,
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function MobileWatchStrip({
  nowSec,
  activeSymbol,
  onSelect,
}: {
  nowSec: number;
  activeSymbol: string;
  onSelect: (symbol: string) => void;
}) {
  const dayStart = dayStartSec(BigInt(nowSec));
  return (
    <div className="scrollbar-thin -mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5 lg:mx-0 lg:px-0">
      <div className="flex w-max gap-2 pb-1">
        {SYMBOLS.map((d) => {
          const spot = pricePaise(d.symbol, BigInt(nowSec));
          const prev = pricePaise(d.symbol, dayStart - 1n);
          const change = spot - prev;
          const up = change >= 0n;
          return (
            <button
              key={d.symbol}
              type="button"
              onClick={() => onSelect(d.symbol)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 transition-colors",
                activeSymbol === d.symbol
                  ? "border-primary/40 bg-primary/10"
                  : "border-border bg-card hover:bg-accent/60",
              )}
            >
              <span className="font-mono text-[12px] font-bold">{d.symbol}</span>
              <span className="tnum font-mono text-[12px] font-semibold">
                {formatINR(spot)}
              </span>
              <span
                className={cn(
                  "tnum font-mono text-[11px] font-semibold",
                  up ? "text-up" : "text-down",
                )}
              >
                {up ? "+" : "-"}
                {(Number(
                  (change < 0n ? -change : change) * 10_000n,
                ) /
                  Number(prev === 0n ? 1n : prev) /
                  100).toFixed(2)}
                %
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
