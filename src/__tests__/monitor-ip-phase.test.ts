import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

vi.mock("../telegram.js", () => ({
  sendMessage: vi.fn(async () => true),
}));

const DB_FILE = join(tmpdir(), `pm-ip-phase-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let monitor: typeof import("../monitor.js");

beforeAll(async () => {
  monitor = await import("../monitor.js");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

describe("IP-probe phase shift (scheduleIpTimer)", () => {
  it("IP-проба не запускается на 300 000 мс, запускается на 322 500 мс, затем каждые 300 000 мс", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    // checkInterval=45000 → phaseMs=22500; первый тик: 22500 + 300000 = 322500
    monitor.scheduleIpTimer(300000, 45000, spy);
    try {
      // T=300 000: setTimeout (22 500) уже сработал, создав setInterval; первый тик ещё впереди
      vi.advanceTimersByTime(300000);
      expect(spy).not.toHaveBeenCalled();

      // T=322 500: первый тик setInterval
      vi.advanceTimersByTime(22500);
      expect(spy).toHaveBeenCalledTimes(1);

      // T=622 500: второй тик (период 300 000)
      vi.advanceTimersByTime(300000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      monitor.stopMonitor();
      vi.useRealTimers();
    }
  });

  it("stopMonitor во время фазы отменяет setTimeout — тик не происходит", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    monitor.scheduleIpTimer(300000, 45000, spy);
    try {
      vi.advanceTimersByTime(5000);
      monitor.stopMonitor();
      vi.advanceTimersByTime(1000000);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
