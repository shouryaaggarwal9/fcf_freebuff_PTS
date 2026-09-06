import { useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Reconciliation loop shared by all book pages: settle due orders on open
 * and every 20s while the page is visible. Purely a *request* to reconcile —
 * the server derives all prices and times itself.
 */
export function useReconcileLoop(enabled: boolean) {
  const reconcileUser = useMutation(api.market.reconcileUser);
  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      reconcileUser().catch((err: unknown) => {
        console.warn("[reconcile]", err instanceof Error ? err.message : err);
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
  }, [enabled, reconcileUser]);
}
