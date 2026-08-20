import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

vi.mock("../config.js", () => ({
  config: {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "12345",
    CHECK_INTERVAL: 45000,
    FAIL_THRESHOLD: 1,
    MAX_PROXIES: 100,
    MAX_ADD_BODY_BYTES: 10000,
    MAX_CONCURRENT_CHECKS: 10,
    ALLOW_PRIVATE_TARGETS: true,
    ENCRYPTION_KEY: "a".repeat(64),
    REMINDER_INTERVAL: 0,
    IP_CHECK_INTERVAL: 300000,
    ROTATION_MAX_AGE: 2700000,
    IP_ECHO_URLS: ["http://api.ipify.org/"],
    CHECK_URL: "http://httpbin.org/status/200",
    CHECK_URL_FALLBACK: "http://www.gstatic.com/generate_204",
    IP_PROBE_FAIL_THRESHOLD: 3,
    HEALTHCHECK_URL: "http://127.0.0.1:9/secret-id",
  },
}));

vi.mock("../checker/liveness.js", () => ({ checkWithFallback: vi.fn() }));
vi.mock("../checker/ip.js", () => ({ fetchExternalIp: vi.fn() }));
vi.mock("../watchdog.js", () => ({ pingWatchdog: vi.fn(async () => true) }));

vi.mock("../telegram.js", () => ({
  sendMessage: vi.fn(async () => true),
  formatDownAlert: () => "down",
  formatReminderAlert: () => "reminder",
  formatRecoveryAlert: () => "recovery",
  formatStaleIpAlert: () => "stale",
  formatRotationOkAlert: () => "resumed",
  formatIpProbeDownAlert: () => "probe down",
  formatIpProbeOkAlert: () => "probe ok",
  formatMassDownAlert: () => "mass down",
  formatMassRecoveryAlert: () => "mass recovery",
  formatIpProbeSystemDownAlert: () => "probe system down",
  formatIpProbeSystemOkAlert: () => "probe system ok",
}));

const DB_FILE = join(tmpdir(), `pm-watchdog-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");
let monitor: typeof import("../monitor.js");
let liveness: typeof import("../checker/liveness.js");
let watchdog: typeof import("../watchdog.js");

beforeAll(async () => {
  db = await import("../db.js");
  monitor = await import("../monitor.js");
  liveness = await import("../checker/liveness.js");
  watchdog = await import("../watchdog.js");

  db.addProxy({ host: "a.example", port: 8080, type: "http" });
});

beforeEach(() => {
  vi.mocked(watchdog.pingWatchdog).mockClear();
  vi.mocked(liveness.checkWithFallback).mockReset();
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

describe("watchdog wiring", () => {
  it("pings after a complete cycle", async () => {
    vi.mocked(liveness.checkWithFallback).mockResolvedValue({
      ok: true,
      responseTime: 5,
      usedFallback: false,
    });

    await monitor.runChecks();

    expect(watchdog.pingWatchdog).toHaveBeenCalledTimes(1);
    expect(watchdog.pingWatchdog).toHaveBeenCalledWith("http://127.0.0.1:9/secret-id");
  });

  it("does not ping when a task in the cycle threw", async () => {
    vi.mocked(liveness.checkWithFallback).mockRejectedValue(new Error("boom"));

    await monitor.runChecks();

    expect(watchdog.pingWatchdog).not.toHaveBeenCalled();
  });
});
