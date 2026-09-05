import { cn } from "@/lib/utils";

/** Three-candle glyph — the app mark. */
export function CandlesIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("size-5", className)}
    >
      {/* wicks */}
      <path
        d="M6.5 5.5v4.2M6.5 15.6v3.4M13.5 4v3M13.5 11.4V20M20 7v3M20 16.8V19"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* bodies */}
      <rect x="4.6" y="9.2" width="3.8" height="6.4" rx="1" fill="#2fce8f" />
      <rect x="11.6" y="7" width="3.8" height="4.4" rx="1" fill="#f0b429" />
      <rect x="18.2" y="10" width="3.8" height="6.8" rx="1" fill="#ff5d73" />
    </svg>
  );
}

/** Square tile + wordmark used in navbars and the sidebar. */
export function Brand({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
        <CandlesIcon className="size-5" />
      </div>
      {!compact && (
        <div className="leading-none">
          <p className="text-[15px] font-bold tracking-tight">
            Paper Trade <span className="text-primary">Pro</span>
          </p>
          <p className="mt-1 text-[9px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
            NSE · 24×7 Simulator
          </p>
        </div>
      )}
    </div>
  );
}
