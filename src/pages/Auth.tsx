/**
 * Auth page — email + password sign-in / sign-up, plus one-tap guest.
 *
 * Project decision (see ARCHITECTURE.md): there is no email handler, so
 * emails are never verified and nothing is ever sent to an inbox. The
 * password IS the credential (hashed with Scrypt server-side by Convex
 * Auth), which makes accounts recoverable on any device. Guests sign in
 * anonymously — instant, but device-local.
 */
import { Brand, CandlesIcon } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SESSIONS, SYMBOLS } from "@/config/market";
import { pricePaise } from "@/engine/price";
import { useAuth } from "@/hooks/use-auth";
import { useNowSec } from "@/hooks/use-now-sec";
import { formatINR } from "@/lib/format";
import {
  ArrowLeft,
  ArrowRight,
  Calculator,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  TimerReset,
  User,
  UserX,
} from "lucide-react";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

const PERKS = [
  {
    icon: <Calculator className="size-4" />,
    title: "₹10,00,000 virtual cash",
    body: "Integer-paise ledger, ₹0.05 ticks, zero leverage.",
  },
  {
    icon: <TimerReset className="size-4" />,
    title: "24×7 deterministic market",
    body: "Price = f(symbol, UTC second). Same on every device.",
  },
  {
    icon: <ShieldCheck className="size-4" />,
    title: "Server-authoritative fills",
    body: "Resting orders settle at exact historical ticks — even while you're away.",
  },
];

function SidePanel() {
  const nowSec = useNowSec(5000);
  const session = SESSIONS[0];
  return (
    <div className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-sidebar p-8 lg:flex xl:p-10">
      <div className="pointer-events-none absolute -top-40 -left-40 size-[480px] rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -right-32 -bottom-40 size-[420px] rounded-full bg-up/5 blur-3xl" />
      <div className="relative flex items-center justify-between">
        <Brand />
        <span className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-[10px] font-bold tracking-widest text-up uppercase">
          <span className="size-1.5 animate-pulse rounded-full bg-up" />
          {session.name}
        </span>
      </div>

      <div className="relative max-w-md">
        <h2 className="text-3xl leading-tight font-bold tracking-tight xl:text-4xl">
          Trade the NSE benchmark names —{" "}
          <span className="text-primary">without a rupee of real money.</span>
        </h2>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          RELIANCE to AXISBANK: a synthetic, deterministic market that never
          sleeps. One account, ten symbols, intraday rules, and fills that are
          final because the server — not your browser — decides them.
        </p>
        <ul className="mt-8 space-y-5">
          {PERKS.map((p) => (
            <li key={p.title} className="flex gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
                {p.icon}
              </span>
              <div>
                <p className="text-sm font-semibold">{p.title}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {p.body}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-10 flex flex-wrap gap-2">
          {SYMBOLS.map((d) => (
            <span
              key={d.symbol}
              className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[10px] font-semibold text-muted-foreground"
            >
              {d.symbol}
            </span>
          ))}
        </div>
        <div className="mt-6 rounded-lg border border-border bg-muted/30 p-3 text-[11px] leading-5 text-muted-foreground">
          <span className="font-semibold text-foreground">Live now — </span>
          {SYMBOLS[0].symbol}{" "}
          <span className="tnum font-mono">{formatINR(pricePaise(SYMBOLS[0].symbol, BigInt(nowSec)))}</span>
          {" · "}
          {SYMBOLS[1].symbol}{" "}
          <span className="tnum font-mono">{formatINR(pricePaise(SYMBOLS[1].symbol, BigInt(nowSec)))}</span>
          {" · "}
          {SYMBOLS[2].symbol}{" "}
          <span className="tnum font-mono">{formatINR(pricePaise(SYMBOLS[2].symbol, BigInt(nowSec)))}</span>
        </div>
      </div>

      <p className="relative text-[10px] leading-4 text-muted-foreground/70">
        Paper trading simulation · synthetic prices · not investment advice.
        <br />
        Day roll 00:00 UTC (05:30 IST) — every day starts flat.
      </p>
    </div>
  );
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );
  const [mode, setMode] = useState<"signIn" | "signUp">("signUp");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      const email = (formData.get("email") as string).trim().toLowerCase();
      const password = (formData.get("password") as string) ?? "";
      if (mode === "signUp") {
        if (password.length < 8) {
          throw new Error("Password must be at least 8 characters.");
        }
        await signIn("password", {
          flow: "signUp",
          email,
          password,
          name: (formData.get("name") as string) ?? "",
        });
      } else {
        await signIn("password", { flow: "signIn", email, password });
      }
      navigate(redirect);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Sign-in failed. Please try again.";
      setError(
        mode === "signIn"
          ? message
          : message.includes("already")
            ? `${message} — try the “Sign in” tab instead.`
            : message,
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleGuestLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signIn("anonymous");
      navigate(redirect);
    } catch (err) {
      console.error("Guest login error:", err);
      setError(
        `Failed to sign in as guest: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <SidePanel />

      {/* Auth form side */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-5 py-4 lg:px-8">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to site
          </button>
          <div className="lg:hidden">
            <Brand compact />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <Card className="w-full max-w-[420px] border bg-card/80 shadow-none backdrop-blur">
            <CardHeader className="text-center">
              <div className="mx-auto mb-3 grid size-11 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
                <CandlesIcon className="size-6" />
              </div>
              <CardTitle className="text-xl tracking-tight">
                {mode === "signUp" ? "Open your paper account" : "Welcome back"}
              </CardTitle>
              <CardDescription>
                {mode === "signUp" ? (
                  <>
                    Every account starts with{" "}
                    <span className="font-semibold text-gold">
                      ₹10,00,000
                    </span>{" "}
                    virtual cash. Email + password — no verification, no
                    emails sent, and your account works on any device.
                  </>
                ) : (
                  <>
                    Sign in with the email and password you created. Your
                    wallet, orders and history are exactly where you left
                    them.
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {/* mode toggle */}
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/40 p-1">
                {(
                  [
                    ["signUp", "Create account"],
                    ["signIn", "Sign in"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setMode(value);
                      setError(null);
                    }}
                    className={`cursor-pointer rounded-md px-3 py-1.5 text-[13px] font-semibold transition-colors ${
                      mode === value
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                {mode === "signUp" && (
                  <div className="relative">
                    <User className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      name="name"
                      placeholder="Trader name (optional)"
                      autoComplete="name"
                      className="pl-9"
                      disabled={isLoading}
                      maxLength={80}
                    />
                  </div>
                )}
                <div className="relative">
                  <Mail className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    name="email"
                    placeholder="name@example.com"
                    type="email"
                    autoComplete="email"
                    className="pl-9"
                    disabled={isLoading}
                    required
                  />
                </div>
                <div className="relative">
                  <Lock className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    name="password"
                    placeholder={
                      mode === "signUp"
                        ? "Password (min. 8 characters)"
                        : "Password"
                    }
                    type="password"
                    autoComplete={
                      mode === "signUp" ? "new-password" : "current-password"
                    }
                    className="pl-9"
                    disabled={isLoading}
                    required
                    minLength={mode === "signUp" ? 8 : undefined}
                  />
                </div>
                <p className="flex items-center justify-center gap-1.5 text-center text-[11px] leading-4 text-muted-foreground">
                  <KeyRound className="size-3 shrink-0" />
                  Emails are{" "}
                  <span className="font-semibold text-foreground">
                    never verified
                  </span>{" "}
                  and nothing is ever sent to your inbox (documented demo
                  choice).
                </p>
                {error && (
                  <p className="rounded-md border border-down/25 bg-down-bg px-3 py-2 text-xs leading-4 text-down">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  className="h-11 w-full gap-1.5 text-sm font-bold"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      {mode === "signUp" ? "Create my account" : "Sign in"}
                      <ArrowRight className="size-4" />
                    </>
                  )}
                </Button>
              </form>

              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
                  or
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleGuestLogin}
                disabled={isLoading}
              >
                <UserX className="mr-2 size-4" />
                Continue instantly as Guest
              </Button>
              <p className="text-center text-[10px] text-muted-foreground">
                Guest mode skips the form entirely — instant, but stays on this
                device only.
              </p>
            </CardContent>
            <CardFooter>
              <p className="w-full border-t border-border pt-3 text-center text-[10px] text-muted-foreground">
                Synthetic deterministic market · demo funds only · no real
                market data
              </p>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}