/**
 * TradingShell — shared authenticated frame for the terminal and its book
 * pages (Orders / History / Positions / Ledger / Analytics). Owns the
 * sidebar navigation, mobile top bar and session footer so every page stays
 * visually identical to the terminal.
 */
import { useAuth } from "@/hooks/use-auth";
import { useNowSec } from "@/hooks/use-now-sec";
import { SESSIONS } from "@/config/market";
import { formatINR, istDayName, istTimeFull } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  BarChart3,
  BookOpen,
  Briefcase,
  CandlestickChart,
  ClipboardList,
  History,
  LogOut,
  TimerReset,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";

export const BOOK_NAV: {
  key: string;
  path: string;
  label: string;
  icon: LucideIcon;
}[] = [
  { key: "terminal", path: "/dashboard", label: "Terminal", icon: CandlestickChart },
  { key: "orders", path: "/orders", label: "Open orders", icon: ClipboardList },
  { key: "history", path: "/history", label: "Order history", icon: History },
  { key: "positions", path: "/positions", label: "Positions", icon: Briefcase },
  { key: "ledger", path: "/ledger", label: "Ledger", icon: BookOpen },
  { key: "analytics", path: "/analytics", label: "Analytics", icon: BarChart3 },
];

interface TradingShellProps {
  /** Which nav item is active (BOOK_NAV key). */
  active: string;
  /** Available cash for the mobile top bar (bigint paise). */
  cash: bigint;
  children: ReactNode;
}

export function TradingShell({ active, cash, children }: TradingShellProps) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const nowSec = useNowSec(1000);
  const session = SESSIONS[0];

  const handleSignOut = async () => {
    try {
      await signOut();
    } finally {
      navigate("/");
    }
  };

  const navButton = (item: (typeof BOOK_NAV)[number], mobile = false) => {
    const isActive = item.key === active;
    const Icon = item.icon;
    return (
      <button
        key={item.key}
        type="button"
        onClick={() => navigate(item.path)}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          mobile && "shrink-0",
        )}
      >
        <Icon className="size-4" />
        {item.label}
      </button>
    );
  };

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
          <nav className="flex flex-col gap-1 px-3">
            {BOOK_NAV.map((item) => navButton(item))}
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
          {/* mobile top bar + nav */}
          <div className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur lg:hidden">
            <div className="flex items-center justify-between px-4 py-3">
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
            <div className="scrollbar-thin flex gap-1 overflow-x-auto px-3 pb-2">
              {BOOK_NAV.map((item) => navButton(item, true))}
            </div>
          </div>

          <div className="mx-auto w-full max-w-[1560px] px-4 py-4 sm:px-5 lg:px-6 lg:py-6">
            {children}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-[10px] text-muted-foreground lg:px-6">
            <p>
              <TimerReset className="mr-1 inline size-3" />
              Deterministic synthetic market — price is a pure function of
              (symbol, UTC second). Server-authoritative fills. Demo only; no
              real money, no real market data.
            </p>
            <p className="tnum font-mono">
              cash {formatINR(cash)} · day roll 05:30 IST
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}

/** Standard page header used by the book pages. */
export function PageHeader({
  title,
  sub,
  right,
}: {
  title: string;
  sub: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-mono text-lg font-bold tracking-tight">{title}</h1>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{sub}</p>
      </div>
      {right}
    </div>
  );
}
