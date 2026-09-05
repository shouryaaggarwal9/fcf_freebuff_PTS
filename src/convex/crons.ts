/**
 * Daily sweep (00:01 UTC) — the pg_cron analogue from the spec, built on
 * Convex's free scheduler. Backstop so abandoned accounts settle within a
 * day: the live client's reconcile_user() achieves the same in real time;
 * both are idempotent and safe to run concurrently.
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.cron(
  "settle-all-accounts-daily",
  "1 0 * * *", // 00:01 UTC — well past the 00:00:00 day rollover
  internal.market.reconcileAllUsers,
);

export default crons;
