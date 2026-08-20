import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

vi.mock("../config.js", () => ({
  config: {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "12345",
    CHECK_INTERVAL: 45000,
    FAIL_THRESHOLD: 4,
    MAX_PROXIES: 100,
    MAX_ADD_BODY_BYTES: 10000,
    MAX_CONCURRENT_CHECKS: 10,
    ALLOW_PRIVATE_TARGETS: false,
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

const DB_FILE = join(tmpdir(), `pm-monitor-test-${process.pid}.db`);
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

  proxyId = Number(db.addProxy({ host: "example.com", port: 8080, type: "http" }).lastInsertRowid);
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

/** Состарить наблюдение так, будто IP не менялся дольше порога. */
function ageObservation(minutes: number) {
  const now = Date.now();
  const state = db.getIpState(proxyId)!;
  db.upsertIpState(
    proxyId,
    state.ip,
    db.toSqlTime(now - minutes * 60_000),
    db.toSqlTime(now)
  );
}

describe("runIpChecks alert deduplication", () => {
  it("sends no alert on the first observation", async () => {
    markUp();
    vi.mocked(ip.fetchExternalIp).mockResolvedValue({ ip: "1.1.1.1" });

    await monitor.runIpChecks();

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(db.getIpState(proxyId)?.ip).toBe("1.1.1.1");
    expect(db.countIpChanges(proxyId, 24)).toBe(0);
  });

  it("sends exactly one stale_ip alert while the IP stays stuck", async () => {
    ageObservation(60);
    markUp();

    await monitor.runIpChecks();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.getLastAlert(proxyId, "rotation")?.type).toBe("stale_ip");

    vi.mocked(telegram.sendMessage).mockClear();
    markUp();
    await monitor.runIpChecks();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("sends exactly one rotation_ok alert when the IP finally changes", async () => {
    vi.mocked(ip.fetchExternalIp).mockResolvedValue({ ip: "2.2.2.2" });
    markUp();

    await monitor.runIpChecks();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.getLastAlert(proxyId, "rotation")?.type).toBe("rotation_ok");
    expect(db.countIpChanges(proxyId, 24)).toBe(1);

    vi.mocked(telegram.sendMessage).mockClear();
    markUp();
    await monitor.runIpChecks();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("does not record the alert when Telegram rejects it", async () => {
    ageObservation(60);
    markUp();
    vi.mocked(telegram.sendMessage).mockResolvedValue(false);

    await monitor.runIpChecks();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.getLastAlert(proxyId, "rotation")?.type).toBe("rotation_ok");
  });

  it("no stale_ip after observation gap — ip_since resets to now", async () => {
    // IP давно не менялся (age > ROTATION_MAX_AGE), но last_probe_at старше
    // 2 × IP_CHECK_INTERVAL — разрыв наблюдения. nextIpState сбрасывает
    // ip_since = now, поэтому isStale = false и ложного алерта не должно быть.
    const now = Date.now();
    db.upsertIpState(
      proxyId,
      "2.2.2.2",
      db.toSqlTime(now - 60 * 60_000),  // ip_since: 60 мин назад (> ROTATION_MAX_AGE=45мин)
      db.toSqlTime(now - 15 * 60_000),  // last_probe_at: 15 мин назад (> 2×IP_CHECK_INTERVAL=10мин)
    );
    vi.mocked(ip.fetchExternalIp).mockResolvedValue({ ip: "2.2.2.2" });
    vi.mocked(telegram.sendMessage).mockResolvedValue(true);
    markUp();

    await monitor.runIpChecks();

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    // ip_since должен быть сброшен на текущее время
    const state = db.getIpState(proxyId)!;
    expect(db.fromSqlTime(state.ip_since)).toBeGreaterThan(now - 1000);
  });
});
