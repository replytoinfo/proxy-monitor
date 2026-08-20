import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";

vi.mock("../config.js", () => ({
  config: {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "12345",
    CHECK_INTERVAL: 45000,
    FAIL_THRESHOLD: 4,
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
    HEALTHCHECK_URL: null,
  },
}));

vi.mock("../checker/ip.js", () => ({ fetchExternalIp: vi.fn() }));

vi.mock("../telegram.js", () => ({
  sendMessage: vi.fn(async () => true),
  formatDownAlert: () => "down",
  formatReminderAlert: () => "reminder",
  formatRecoveryAlert: () => "recovery",
  formatStaleIpAlert: () => "stale",
  formatRotationOkAlert: () => "resumed",
  formatIpProbeDownAlert: () => "probe down",
  formatIpProbeOkAlert: () => "probe ok",
}));

const DB_FILE = join(tmpdir(), `pm-probe-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");
let monitor: typeof import("../monitor.js");
let telegram: typeof import("../telegram.js");
let ip: typeof import("../checker/ip.js");
let proxyId: number;

beforeAll(async () => {
  db = await import("../db.js");
  monitor = await import("../monitor.js");
  telegram = await import("../telegram.js");
  ip = await import("../checker/ip.js");

  proxyId = Number(
    db.addProxy({ host: "example.com", port: 8080, type: "http" }).lastInsertRowid
  );
});

beforeEach(() => {
  vi.mocked(telegram.sendMessage).mockClear();
  vi.mocked(telegram.sendMessage).mockResolvedValue(true);
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

/** Свежий up-статус — иначе прокси не попадёт в выборку IP-проверки. */
function markUp() {
  db.saveCheck(proxyId, "up", 100, null);
}

describe("ip_probe_failures storage", () => {
  it("survives reopening the database", () => {
    const t = "2026-01-01 12:00:00";
    db.upsertProbeFailure(proxyId, 2, t, t, "Timeout");

    const second = new Database(DB_FILE, { readonly: true });
    const row = second
      .prepare(`SELECT * FROM ip_probe_failures WHERE proxy_id = ?`)
      .get(proxyId) as { fails: number; last_error: string };
    second.close();

    expect(row.fails).toBe(2);
    expect(row.last_error).toBe("Timeout");

    db.clearProbeFailure(proxyId);
    expect(db.getProbeFailure(proxyId)).toBeUndefined();
  });

  it("is removed together with the proxy", () => {
    const id = Number(
      db.addProxy({ host: "gone.example", port: 1080, type: "socks5" }).lastInsertRowid
    );
    const t = "2026-01-01 12:00:00";
    db.upsertProbeFailure(id, 1, t, t, "Timeout");
    expect(db.getProbeFailure(id)).toBeDefined();

    db.deleteProxy(id);
    expect(db.getProbeFailure(id)).toBeUndefined();
  });
});

describe("ip probe blind spot alerts", () => {
  it("stays quiet for the first two failures and alerts on the third", async () => {
    vi.mocked(ip.fetchExternalIp).mockResolvedValue({ error: "Timeout" });

    markUp();
    await monitor.runIpChecks();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(db.getProbeFailure(proxyId)?.fails).toBe(1);

    markUp();
    await monitor.runIpChecks();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(db.getProbeFailure(proxyId)?.fails).toBe(2);

    markUp();
    await monitor.runIpChecks();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.getLastAlert(proxyId, "probe")?.type).toBe("ip_probe_down");
  });

  it("does not repeat the alert while the probe keeps failing", async () => {
    markUp();
    await monitor.runIpChecks();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(db.getProbeFailure(proxyId)?.fails).toBe(4);
  });

  it("sends ip_probe_ok and clears the counter on the first success", async () => {
    vi.mocked(ip.fetchExternalIp).mockResolvedValue({ ip: "203.0.113.7" });

    markUp();
    await monitor.runIpChecks();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.getLastAlert(proxyId, "probe")?.type).toBe("ip_probe_ok");
    expect(db.getProbeFailure(proxyId)).toBeUndefined();
  });

  it("restarts the series when the previous failure is older than two intervals", async () => {
    vi.mocked(ip.fetchExternalIp).mockResolvedValue({ error: "Timeout" });

    const stale = db.toSqlTime(Date.now() - 15 * 60_000); // > 2 × IP_CHECK_INTERVAL
    db.upsertProbeFailure(proxyId, 2, stale, stale, "Timeout");

    markUp();
    await monitor.runIpChecks();

    expect(db.getProbeFailure(proxyId)?.fails).toBe(1);
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("does not mix probe alerts into the rotation lookup", () => {
    expect(db.getLastAlert(proxyId, "rotation")).toBeUndefined();
  });
});
