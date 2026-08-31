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
    MAX_CONCURRENT_CHECKS: 1,
    ALLOW_PRIVATE_TARGETS: true,
    ENCRYPTION_KEY: "a".repeat(64),
    REMINDER_INTERVAL: 0,
    IP_CHECK_INTERVAL: 300000,
    ROTATION_MAX_AGE: 2700000,
    IP_ECHO_URLS: ["http://api.ipify.org/"],
    CHECK_URL: "http://httpbin.org/status/200",
    CHECK_URL_FALLBACK: "http://www.gstatic.com/generate_204",
    IP_PROBE_FAIL_THRESHOLD: 3,
    HEALTHCHECK_URL: null,
  },
}));

vi.mock("../checker/liveness.js", () => ({ checkWithFallback: vi.fn() }));
vi.mock("../checker/ip.js", () => ({ fetchExternalIp: vi.fn() }));

vi.mock("../telegram.js", () => ({
  sendMessage: vi.fn(async () => true),
  formatDownAlert: () => "down",
  formatReminderAlert: () => "reminder",
  formatRecoveryAlert: () => "recovery",
  formatStaleIpAlert: () => "stale",
  formatRotationOkAlert: () => "resumed",
}));

const DB_FILE = join(tmpdir(), `pm-checks-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");
let monitor: typeof import("../monitor.js");
let liveness: typeof import("../checker/liveness.js");

beforeAll(async () => {
  db = await import("../db.js");
  monitor = await import("../monitor.js");
  liveness = await import("../checker/liveness.js");
  db.addProxy({ host: "example.com", port: 8080, type: "http" });
});

beforeEach(() => {
  vi.mocked(liveness.checkWithFallback).mockReset();
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

describe("runChecks overlap guard", () => {
  it("skips a tick while the previous run is still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.mocked(liveness.checkWithFallback).mockImplementation(async () => {
      await gate;
      return { ok: true, responseTime: 5, usedFallback: false };
    });

    const first = monitor.runChecks();
    await monitor.runChecks();

    expect(liveness.checkWithFallback).toHaveBeenCalledTimes(1);

    release();
    await first;

    // После завершения первого прогона тик снова принимается.
    vi.mocked(liveness.checkWithFallback).mockResolvedValue({
      ok: true,
      responseTime: 5,
      usedFallback: false,
    });
    await monitor.runChecks();
    expect(liveness.checkWithFallback).toHaveBeenCalledTimes(2);
  });

  it("помечает запись, когда проверка прошла только через запасной адрес", async () => {
    vi.mocked(liveness.checkWithFallback).mockResolvedValue({
      ok: true,
      responseTime: 10400,
      usedFallback: true,
    });

    await monitor.runChecks();

    const proxy = db.getProxies()[0];
    const last = db.getLastCheck(proxy.id)!;
    expect(last.status).toBe("up");
    expect(last.used_fallback).toBe(1);
  });

  it("не помечает запись, когда хватило основного адреса", async () => {
    vi.mocked(liveness.checkWithFallback).mockResolvedValue({
      ok: true,
      responseTime: 250,
      usedFallback: false,
    });

    await monitor.runChecks();

    const proxy = db.getProxies()[0];
    expect(db.getLastCheck(proxy.id)!.used_fallback).toBe(0);
  });

  it("records the fallback error text in the check row", async () => {
    vi.mocked(liveness.checkWithFallback).mockResolvedValue({
      ok: false,
      responseTime: 42,
      error: "основной: Timeout; запасной: HTTP 500",
      usedFallback: true,
    });

    await monitor.runChecks();

    const proxy = db.getProxies()[0];
    const last = db.getLastCheck(proxy.id)!;
    expect(last.status).toBe("down");
    expect(last.error).toBe("основной: Timeout; запасной: HTTP 500");
    expect(last.response_time).toBe(42);
  });
});
