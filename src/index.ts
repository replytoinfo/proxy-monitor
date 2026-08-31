import * as Sentry from "@sentry/node";
import { startMonitor, stopMonitor } from "./monitor.js";
import { startPolling, stopPolling } from "./telegram.js";

console.log("[proxy-monitor] Starting...");

startMonitor();
startPolling();

// Graceful shutdown
const shutdown = async () => {
  console.log("[proxy-monitor] Shutting down...");
  stopMonitor();
  stopPolling();
  await Sentry.flush(2000);
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
