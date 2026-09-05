/**
 * Landing page — NSE Paper Trade Pro.
 * Public marketing surface. The hero chart + ticker render the deterministic
 * engine live in the browser (display only) so a visitor immediately sees
 * that the market is real, continuous and reproducible.
 */
import { useAuth } from "@/hooks/use-auth";
import { useNowSec } from "@/hooks/use-now-sec";
import { Brand } from "@/components/brand";
import { CandleChart } from "@/components/trading/CandleChart";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { SESSIONS, SYMBOLS } from "@/config/market";
import { candleSeries } from "@/engine/candles";
import { dayStartSec, pricePaise } from "@/engine/price";
import { cn } from "@/lib/utils";
import { formatINR, istTimeFull, signedINR } from "@/lib/format";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  Banknote,
  CandlestickChart,
  Clock3,
  Coins,
  FunctionSquare,
  PiggyBank,
  ScrollText,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";

const session = SESSIONS[0];

/* ------------------------------- helpers -------------------------------- */

function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.5, delay, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function priceDelta(symbol: string, nowSec: number) {
  const dayStart = dayStartSec(BigInt(nowSec));
  const spot = pricePaise(symbol, BigInt(nowSec));
  const prev = pricePaise(symbol, dayStart - 1n);
  const change = spot - prev;
  return { spot, prev, change, up: change >= 0n };
}

/* ------------------------------ ticker tape ----------------------------- */

function TickerTape({ nowSec }: { nowSec: number }) {
  const items = SYMBOLS.map((d) => {
    const { spot, change, up } = priceDelta(d.symbol, nowSec);
    return { symbol: d.symbol, spot, change, up };
  });
  const strip = (keyPrefix: string) => (
    <div className="flex shrink-0 items-center">
      {items.map((it) => (
        <span key={`${keyPrefix}-${it.symbol}`} className="flex items-center">
          <span className="px-5 font-mono text-[12px] font-bold tracking-wide">
            {it.symbol}
          </span>
          <span className="tnum px-2 font-mono text-[12px] font-semibold text-foreground/80">
            {formatINR(it.spot)}
          </span>
          <span
            className={cn(
              "tnum px-2 font-mono text-[11px] font-semibold",
              it.up ? "text-up" : "text-down",
            )}
          >
            {signedINR(it.change)}
          </span>
          <span className="px-4 text-border/60">•</span>
        </span>
      ))}
    </div>
  );
  return (
    <div className="pause-on-hover relative overflow-hidden border-y border-border bg-sidebar/80 py-2">
      <div className="animate-ticker flex w-max">
        {strip("a")}
        {strip("b")}
      </div>
    </div>
  );
}

/* ------------------------------- features ------------------------------- */

const FEATURES = [
  {
    icon: <FunctionSquare className="size-5" />,
    title: "Deterministic 24×7 market",
    body: "Price is a pure function of (symbol, UTC second) — multi-scale integer waves hashed from a frozen config. Every device, every day, the same past.",
  },
  {
    icon: <ServerCog className="size-5" />,
    title: "Server-authoritative fills",
    body: "The backend is the only matching engine. Close the tab for a day: your resting orders settle at the exact historical second they triggered.",
  },
  {
    icon: <Coins className="size-5" />,
    title: "₹10,00,000 of play money",
    body: "Fresh accounts start fully funded. Integer-paise wallet, append-only ledger, ₹0.05 ticks — no floats, no rounding drift, ever.",
  },
  {
    icon: <ScrollText className="size-5" />,
    title: "Intraday rule book",
    body: "Long-only, cash-only, no leverage. Whatever is still open squares off automatically at the 00:00 UTC day roll — every day starts flat.",
  },
  {
    icon: <CandlestickChart className="size-5" />,
    title: "Organic multi-scale charts",
    body: "60-second anchors ride four deterministic waves (day → 10 min) for live candles that look like a market — because they're reproducible, not random.",
  },
  {
    icon: <PiggyBank className="size-5" />,
    title: "Zero budget, zero risk",
    body: "No market-data API, no paid feeds, no real money. A daily server sweep is the only scheduled job; everything else runs when you trade.",
  },
];

const STEPS = [
  {
    step: "01",
    icon: <Wallet className="size-5" />,
    title: "Open an account",
    body: "Sign up with email + password — no verification, nothing sent to your inbox — or one-tap guest. Either way your wallet is credited ₹10,00,000 instantly, and your account follows you to any device.",
  },
  {
    step: "02",
    icon: <Activity className="size-5" />,
    title: "Trade any of the 10",
    body: "Market, limit and stop-loss orders across RELIANCE, TCS, HDFCBANK, INFY, ICICIBANK, SBIN, BHARTIARTL, ITC, LT and AXISBANK.",
  },
  {
    step: "03",
    icon: <ShieldCheck className="size-5" />,
    title: "Leave, and it still settles",
    body: "The browser renders charts; the server decides fills from its own clock and the deterministic price. Come back hours later — history is exactly what happened.",
  },
];

const FAQS = [
  {
    q: "Is this a real market?",
    a: "No. Prices come from a deterministic generator evaluated at (symbol, UTC second). There is no real market data, no feed and no connection to any exchange — which is exactly why it can run 24/7 with nothing to pay.",
  },
  {
    q: "How can orders fill while my tab is closed?",
    a: "Fills are decided by the server, which re-evaluates every open order over its eligible ticks whenever you (or the daily sweep) trigger a reconciliation. A limit order that would have triggered at 03:14 while you slept fills at that exact historical tick when you return.",
  },
  {
    q: "Why is the day rollover at 00:00 UTC?",
    a: "The market is continuous across the UTC day boundary, but the rule book is intraday: every open position is force-squared at the last tick of its UTC day (05:29:59 IST) so each day begins flat. There is no overnight risk to carry.",
  },
  {
    q: "What are the order rules?",
    a: "Long-only, cash-only, no leverage. Buy orders reserve cash at their reference price; sell orders need quantity held today. Resting orders are cancelled automatically at day end if they never trigger.",
  },
  {
    q: "Can price history change later?",
    a: "Never. The generator is a pure integer function of the frozen constants in src/config/market.ts and the epoch second. Anyone can recompute any historical candle — there is no hidden state to disagree with.",
  },
];

/* --------------------------------- page --------------------------------- */

export default function Landing() {
  const { isLoading, isAuthenticated } = useAuth();
  const nowSec = useNowSec(1000);
  const [featuredIdx, setFeaturedIdx] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setFeaturedIdx((i) => (i + 1) % SYMBOLS.length);
    }, 6000);
    return () => window.clearInterval(id);
  }, []);

  const featured = SYMBOLS[featuredIdx];
  const featuredDelta = priceDelta(featured.symbol, nowSec);

  const heroCandles = useMemo(
    () => candleSeries(featured.symbol, nowSec, 60, 150),
    [featured.symbol, nowSec],
  );

  const primaryHref = isAuthenticated ? "/dashboard" : "/auth";
  const primaryLabel = isAuthenticated ? "Open your terminal" : "Start trading — it's free";

  return (
    <div className="min-h-screen scroll-smooth bg-background text-foreground">
      {/* ------------------------------ Navbar ------------------------------ */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="cursor-pointer">
            <Brand />
          </Link>
          <nav className="ml-auto hidden items-center gap-6 text-[13px] font-medium text-muted-foreground md:flex">
            <a href="#features" className="transition-colors hover:text-foreground">
              Features
            </a>
            <a href="#how" className="transition-colors hover:text-foreground">
              How it works
            </a>
            <a href="#symbols" className="transition-colors hover:text-foreground">
              Symbols
            </a>
            <a href="#faq" className="transition-colors hover:text-foreground">
              FAQ
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            {!isAuthenticated && !isLoading && (
              <Link
                to="/auth"
                className="hidden text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:block"
              >
                Sign in
              </Link>
            )}
            <Link to={primaryHref}>
              <Button type="button" className="h-9 gap-1.5 px-4 text-[13px] font-semibold">
                {primaryLabel}
                <ArrowRight className="size-3.5" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <TickerTape nowSec={nowSec} />

      {/* ------------------------------ Hero ------------------------------ */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(56,130,246,0.08),transparent_55%)]" />
        <div className="pointer-events-none absolute -top-24 -right-24 size-[420px] rounded-full bg-primary/5 blur-3xl" />
        <div className="mx-auto grid w-full max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:py-24">
          <div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45 }}
              className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-bold tracking-[0.16em] text-primary uppercase"
            >
              <Sparkles className="size-3.5" />
              {session.name} · deterministic synthetic market
            </motion.div>
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.06 }}
              className="mt-5 text-4xl leading-[1.06] font-bold tracking-tight sm:text-5xl xl:text-6xl"
            >
              Trade India&apos;s biggest names on a market that{" "}
              <span className="text-primary">never sleeps</span>.
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.14 }}
              className="mt-5 max-w-xl text-[15px] leading-7 text-muted-foreground sm:text-base"
            >
              A paper-trading simulator for 10 NSE heavyweights with{" "}
              <span className="text-foreground">₹10,00,000 virtual cash</span>,
              intraday-only rules and server-authoritative fills. Close the tab —
              your resting orders still settle at the exact historical tick.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.22 }}
              className="mt-8 flex flex-wrap items-center gap-3"
            >
              <Link to={primaryHref}>
                <Button type="button" size="lg" className="h-12 gap-2 px-6 text-[15px] font-bold">
                  {primaryLabel}
                  <ArrowRight className="size-4" />
                </Button>
              </Link>
              <a href="#how">
                <Button type="button" size="lg" variant="outline" className="h-12 px-6 text-[15px]">
                  How it works
                </Button>
              </a>
            </motion.div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.34 }}
              className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[12px] font-medium text-muted-foreground"
            >
              <span className="flex items-center gap-1.5">
                <Banknote className="size-3.5 text-gold" /> ₹10,00,000 virtual cash
              </span>
              <span className="flex items-center gap-1.5">
                <Coins className="size-3.5 text-primary" /> ₹0.05 tick · integer paise
              </span>
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="size-3.5 text-up" /> No leverage · long-only
              </span>
              <span className="flex items-center gap-1.5">
                <Clock3 className="size-3.5 text-down" /> Intraday, auto square-off
              </span>
            </motion.div>
          </div>

          {/* live hero chart */}
          <motion.div
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.18 }}
          >
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <div className="flex flex-wrap gap-1.5">
                    {SYMBOLS.map((d, i) => (
                      <button
                        key={d.symbol}
                        type="button"
                        onClick={() => setFeaturedIdx(i)}
                        className={cn(
                          "rounded-md px-2 py-1 font-mono text-[10px] font-bold transition-colors",
                          i === featuredIdx
                            ? "bg-primary/15 text-primary"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                      >
                        {d.symbol}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="tnum hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:block">
                  {istTimeFull(nowSec * 1000)} IST
                </span>
              </div>
              <div className="flex items-baseline gap-x-3 px-4 pt-3">
                <h2 className="font-mono text-xl font-bold tracking-tight">
                  {featured.symbol}
                </h2>
                <span className="tnum font-mono text-xl font-bold">
                  {formatINR(featuredDelta.spot)}
                </span>
                <span
                  className={cn(
                    "tnum font-mono text-[12px] font-semibold",
                    featuredDelta.up ? "text-up" : "text-down",
                  )}
                >
                  {signedINR(featuredDelta.change)}
                </span>
                <span className="ml-auto truncate text-[10px] text-muted-foreground">
                  {featured.label}
                </span>
              </div>
              <div key={featured.symbol} className="mt-1">
                <CandleChart symbol={featured.symbol} candles={heroCandles} height={300} />
              </div>
              <div className="border-t border-border px-4 py-2.5 text-[10px] leading-4 text-muted-foreground">
                Live preview — candles are recomputed from the deterministic
                price function; nothing is streamed or stored.
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ------------------------------ Stats ------------------------------ */}
      <section className="border-y border-border bg-sidebar/60">
        <div className="mx-auto grid w-full max-w-7xl grid-cols-2 divide-x divide-border sm:grid-cols-4">
          {[
            ["10", "NSE symbols"],
            ["24×7", "continuous trading"],
            ["₹0", "cost · no data feeds"],
            ["₹0.05", "minimum tick"],
          ].map(([v, l], i) => (
            <Reveal key={l} delay={i * 0.05} className="px-6 py-8 text-center">
              <p className="tnum font-mono text-3xl font-bold tracking-tight">{v}</p>
              <p className="mt-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {l}
              </p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------------------- Features ---------------------------- */}
      <section id="features" className="mx-auto w-full max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
        <Reveal className="max-w-2xl">
          <p className="text-[11px] font-bold tracking-[0.2em] text-primary uppercase">
            Engineered like an exchange
          </p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            A simulator that behaves like the real thing — because the server decides.
          </h2>
        </Reveal>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 0.06}>
              <div className="group h-full rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/30">
                <div className="grid size-10 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary transition-transform group-hover:-translate-y-0.5">
                  {f.icon}
                </div>
                <h3 className="mt-4 text-[15px] font-bold tracking-tight">{f.title}</h3>
                <p className="mt-1.5 text-[13px] leading-6 text-muted-foreground">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ----------------------------- How it works ----------------------------- */}
      <section id="how" className="scroll-mt-20 border-y border-border bg-sidebar/50">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
          <Reveal className="max-w-2xl">
            <p className="text-[11px] font-bold tracking-[0.2em] text-primary uppercase">
              Three steps
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              From sign-up to square-off in minutes.
            </h2>
          </Reveal>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <Reveal key={s.step} delay={i * 0.08}>
                <div className="relative h-full overflow-hidden rounded-xl border border-border bg-card p-6">
                  <span className="absolute -top-3 -right-2 font-mono text-7xl font-black text-foreground/[0.045]">
                    {s.step}
                  </span>
                  <div className="grid size-10 place-items-center rounded-lg border border-gold/30 bg-gold/10 text-gold">
                    {s.icon}
                  </div>
                  <h3 className="mt-4 text-[15px] font-bold tracking-tight">{s.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-6 text-muted-foreground">{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal className="mt-6">
            <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-5">
              <FunctionSquare className="mt-0.5 size-5 shrink-0 text-primary" />
              <p className="text-[13px] leading-6 text-muted-foreground">
                <span className="font-semibold text-foreground">
                  Deterministic past, guaranteed.
                </span>{" "}
                Every candle you see is recomputed from a frozen constant set —
                never from session state, order history or device randomness. The
                same history exists for a user who trades live as for one who
                returns after a week away.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------ Symbols ------------------------------ */}
      <section id="symbols" className="mx-auto w-full max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
        <Reveal className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold tracking-[0.2em] text-primary uppercase">
              The universe
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              Ten blue chips, one frozen config.
            </h2>
          </div>
          <p className="max-w-sm text-[12px] leading-5 text-muted-foreground">
            Base prices and volatility factors are frozen in a single market
            config — change them and you&apos;ve created a brand-new market, not
            a bug.
          </p>
        </Reveal>
        <Reveal className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  <th className="px-5 py-3">Symbol</th>
                  <th className="px-5 py-3">Company</th>
                  <th className="px-5 py-3 text-right">Reference price</th>
                  <th className="px-5 py-3 text-right">Live</th>
                  <th className="px-5 py-3 w-56">Day drift range</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {SYMBOLS.map((d) => {
                  const { spot, change, up } = priceDelta(d.symbol, nowSec);
                  const barW = Math.max(18, Math.min(96, d.volBp * 0.62));
                  const volTxt = (d.volBp / 100).toFixed(2);
                  return (
                    <tr key={d.symbol} className="transition-colors hover:bg-muted/20">
                      <td className="px-5 py-3.5 font-mono text-[13px] font-bold">{d.symbol}</td>
                      <td className="px-5 py-3.5 text-[13px] text-muted-foreground">{d.label}</td>
                      <td className="tnum px-5 py-3.5 text-right font-mono text-[13px]">
                        {formatINR(BigInt(d.basePaise))}
                      </td>
                      <td className="tnum px-5 py-3.5 text-right font-mono text-[13px] font-semibold">
                        {formatINR(spot)}
                        <span className={cn("ml-2 text-[11px]", up ? "text-up" : "text-down")}>
                          {signedINR(change)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div
                          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                          title={`Relative volatility factor ×${volTxt}`}
                        >
                          <div
                            className={cn("h-full rounded-full", up ? "bg-up/70" : "bg-down/70")}
                            style={{ width: `${barW}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Reveal>
      </section>

      {/* ------------------------------- FAQ ------------------------------- */}
      <section id="faq" className="scroll-mt-20 border-t border-border bg-sidebar/50">
        <div className="mx-auto w-full max-w-3xl px-4 py-20 sm:px-6">
          <Reveal className="text-center">
            <p className="text-[11px] font-bold tracking-[0.2em] text-primary uppercase">
              FAQ
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              Questions, answered honestly.
            </h2>
          </Reveal>
          <Reveal className="mt-8">
            <Accordion type="single" collapsible>
              {FAQS.map((f, i) => (
                <AccordionItem key={f.q} value={`faq-${i}`}>
                  <AccordionTrigger className="text-left text-[15px] font-semibold">
                    {f.q}
                  </AccordionTrigger>
                  <AccordionContent className="text-[13px] leading-6 text-muted-foreground">
                    {f.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </Reveal>
        </div>
      </section>

      {/* -------------------------------- CTA -------------------------------- */}
      <section className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
        <Reveal>
          <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-primary/5 px-6 py-14 text-center sm:px-12">
            <div className="pointer-events-none absolute -top-32 left-1/2 h-64 w-[560px] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
            <h2 className="relative mx-auto max-w-2xl text-3xl leading-tight font-bold tracking-tight sm:text-4xl">
              ₹10,00,000 of play money is already waiting for you.
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-[14px] leading-6 text-muted-foreground">
              Sign up in seconds, trade ten NSE names on a deterministic market
              that never closes — and practice a real, rules-based intraday
              process without risking a rupee.
            </p>
            <div className="relative mt-8 flex flex-wrap justify-center gap-3">
              <Link to={primaryHref}>
                <Button type="button" size="lg" className="h-12 gap-2 px-7 text-[15px] font-bold">
                  {primaryLabel}
                  <ArrowRight className="size-4" />
                </Button>
              </Link>
              <a href="#features">
                <Button type="button" size="lg" variant="outline" className="h-12 px-7 text-[15px]">
                  Read the features
                </Button>
              </a>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ------------------------------- Footer ------------------------------- */}
      <footer className="border-t border-border bg-sidebar/70">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-12 sm:px-6 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <Brand />
            <p className="mt-3 text-[12px] leading-5 text-muted-foreground">
              A zero-cost paper-trading simulator for ten NSE-listed equities on
              a synthetic, deterministic 24×7 market.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-10 text-[12px] sm:grid-cols-3">
            <div>
              <p className="mb-3 font-semibold tracking-wide uppercase">Product</p>
              <ul className="space-y-2 text-muted-foreground">
                <li><a href="#features" className="hover:text-foreground">Features</a></li>
                <li><a href="#how" className="hover:text-foreground">How it works</a></li>
                <li><a href="#symbols" className="hover:text-foreground">Symbols</a></li>
                <li><a href="#faq" className="hover:text-foreground">FAQ</a></li>
              </ul>
            </div>
            <div>
              <p className="mb-3 font-semibold tracking-wide uppercase">Market</p>
              <ul className="space-y-2 text-muted-foreground">
                <li>{session.name}</li>
                <li>Day roll 00:00 UTC</li>
                <li>Intraday · long-only</li>
                <li>Server-side fills</li>
              </ul>
            </div>
            <div>
              <p className="mb-3 font-semibold tracking-wide uppercase">Start</p>
              <ul className="space-y-2 text-muted-foreground">
                <li>
                  <Link to="/auth" className="hover:text-foreground">Sign in</Link>
                </li>
                <li>
                  <Link to="/auth" className="hover:text-foreground">Create account</Link>
                </li>
                <li>
                  <Link to="/dashboard" className="hover:text-foreground">Terminal</Link>
                </li>
              </ul>
            </div>
          </div>
        </div>
        <div className="border-t border-border">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-5 text-[10px] text-muted-foreground/80 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>
              Demo simulation · synthetic prices only · not investment advice ·
              nothing here is real money.
            </p>
            <p>
              Charting powered by TradingView Lightweight Charts™ (Apache-2.0).
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
