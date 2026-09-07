/**
 * Ledger — the append-only cash ledger with server-computed running
 * balances. Rows are never updated or deleted; deposits, reservations,
 * fills and releases all flow through here.
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
import { formatINR, istDayLabel, istTimeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BookOpen } from "lucide-react";
import { useMemo } from "react";

const ENTRY_LABEL: Record<string, string> = {
  deposit: "Opening deposit",
  reserve: "Cash reserved",
  reserve_release: "Reservation released",
  buy_fill: "Buy fill",
  sell_fill: "Sell fill",
  margin_block: "Margin blocked (short entry)",
  cover_settle: "Short cover settlement",
};;

export default function Ledger() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  void isAuthenticated;
  void authLoading;
  const account = useQuery(api.market.getAccount);
  const ledger = useQuery(api.market.getLedger);

  const rows = useMemo(() => [...(ledger ?? [])].reverse(), [ledger]);

  const deposits = useMemo(() => {
    let sum = 0n;
    for (const r of ledger ?? []) {
      if (r.entryType === "deposit") sum += r.amountPaise;
    }
    return sum;
  }, [ledger]);

  return (
    <TradingShell active="ledger" cash={account?.availableCashPaise ?? 0n}>
      <PageHeader
        title="Cash ledger"
        sub="Append-only record of every rupee movement. Balances are computed by the server; rows are immutable."
        right={
          <span className="tnum rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-[12px] text-muted-foreground">
            {rows.length} entries · funded {formatINR(deposits)}
          </span>
        }
      />
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        {ledger === undefined ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 border-t border-border px-4 py-14 text-center">
            <BookOpen className="size-4 text-muted-foreground/60" />
            <p className="max-w-sm text-[12px] leading-5 text-muted-foreground">
              Your ledger is empty — it fills the moment your virtual account
              is funded with ₹10,00,000.
            </p>
          </div>
        ) : (
          <div className="scrollbar-thin max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const isCredit =
                    r.entryType === "deposit" ||
                    r.entryType === "reserve_release" ||
                    r.entryType === "sell_fill" ||
                    r.entryType === "cover_settle" ||
                    (r.entryType !== "reserve" && r.entryType !== "buy_fill" && r.amountPaise > 0n);
                  return (
                    <TableRow key={r._id} className="hover:bg-muted/30">
                      <TableCell className="tnum whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                        {istDayLabel(r.timeMs)} {istTimeLabel(r.timeMs)}
                      </TableCell>
                      <TableCell className="text-[12px]">{ENTRY_LABEL[r.entryType] ?? r.entryType}</TableCell>
                      <TableCell
                        className={cn(
                          "tnum text-right font-mono font-semibold",
                          isCredit ? "text-up" : "text-down",
                        )}
                      >
                        {isCredit ? "+" : ""}
                        {formatINR(r.amountPaise)}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono text-muted-foreground">
                        {formatINR(r.runningBalancePaise)}
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
