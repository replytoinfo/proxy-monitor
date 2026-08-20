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
    IP_PROBE_FAIL_THRESHOLD: 1,
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
  formatIpProbeDownAlert: () => "probe down",
  formatIpProbeOkAlert: () => "probe ok",
  formatMassDownAlert: (count: number) => `mass down ${count}`,
  formatMassRecoveryAlert: () => "mass recovery",
  formatIpProbeSystemDownAlert: (count: number) => `probe system down ${count}`,
  formatIpProbeSystemOkAlert: () => "probe system ok",
}));

const DB_FILE = join(tmpdir(), `pm-system-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");
let monitor: typeof import("../monitor.js");
let telegram: typeof import("../telegram.js");
let liveness: typeof import("../checker/liveness.js");
let ip: typeof import("../checker/ip.js");
let idA: number;
let idB: number;
let idC: number;

beforeAll(async () => {
  db = await import("../db.js");
  monitor = await import("../monitor.js");
  telegram = await import("../telegram.js");
  liveness = await import("../checker/liveness.js");
  ip = await import("../checker/ip.js");

  idA = Number(db.addProxy({ host: "a.example", port: 8080, type: "http" }).lastInsertRowid);
  idB = Number(db.addProxy({ host: "b.example", port: 8080, type: "http" }).lastInsertRowid);
  // idC is disabled by default; enabled only where explicitly needed
  idC = Number(db.addProxy({ host: "c.example", port: 8080, type: "http" }).lastInsertRowid);
  db.toggleProxy(idC, false);
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

function allDown() {
  vi.mocked(liveness.checkWithFallback).mockResolvedValue({
    ok: false,
    responseTime: 10,
    error: "Timeout",
    usedFallback: true,
  });
}

function firstUp() {
  vi.mocked(liveness.checkWithFallback).mockImplementation(async (proxy) =>
    proxy.id === idA
      ? { ok: true, responseTime: 10, usedFallback: false }
      : { ok: false, responseTime: 10, error: "Timeout", usedFallback: true }
  );
}

describe("mass outage", () => {
  it("sends one mass_down instead of an alert per proxy", async () => {
    allDown();
    await monitor.runChecks();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith("mass down 2");
    expect(db.getLastSystemAlert("mass")?.type).toBe("mass_down");

    // Подавленные down в alerts не попадают — иначе появятся напоминания и recovery.
    expect(db.getLastAlert(idA, "uptime")).toBeUndefined();
    expect(db.getLastAlert(idB, "uptime")).toBeUndefined();
  });

  it("does not repeat mass_down on the next cycle", async () => {
    allDown();
    await monitor.runChecks();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("sends mass_recovery and still holds individual alerts for one cycle", async () => {
    firstUp();
    await monitor.runChecks();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith("mass recovery");
    expect(db.getLastSystemAlert("mass")?.type).toBe("mass_recovery");
    expect(db.getLastAlert(idB, "uptime")).toBeUndefined();
  });

  it("resumes ordinary individual alerts on the following cycle", async () => {
    firstUp();
    await monitor.runChecks();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith("down");
    expect(db.getLastAlert(idB, "uptime")?.type).toBe("down");
  });

  it("draws no mass conclusion from a cycle with a thrown task", async () => {
    // idC enabled so that checked = [idB, idC] (2 elements) when idA throws.
    // Without the `incomplete` guard, checked.length >= 2 && allDown would fire
    // mass_down. The guard is the only barrier here.
    db.saveAlert(idB, "recovery");
    db.toggleProxy(idC, true);
    vi.mocked(liveness.checkWithFallback).mockImplementation(async (proxy) => {
      if (proxy.id === idA) throw new Error("boom");
      return { ok: false, responseTime: 10, error: "Timeout", usedFallback: true };
    });

    await monitor.runChecks();

    expect(telegram.sendMessage).not.toHaveBeenCalledWith("mass down 2");
    expect(db.getLastSystemAlert("mass")?.type).toBe("mass_recovery");

    db.toggleProxy(idC, false);
  });

  it("draws no mass conclusion from a cycle without proxies", async () => {
    db.toggleProxy(idA, false);
    db.toggleProxy(idB, false);
    allDown();

    await monitor.runChecks();
    expect(telegram.sendMessage).not.toHaveBeenCalled();

    db.toggleProxy(idA, true);
    db.toggleProxy(idB, true);
  });

  it("does not send mass_down for a single down proxy", async () => {
    // Only idA active. Without the checked.length >= 2 threshold,
    // mass_down would fire (1 element, all down). With it, it doesn't.
    db.toggleProxy(idB, false);
    allDown();

    await monitor.runChecks();

    expect(telegram.sendMessage).not.toHaveBeenCalledWith("mass down 1");

    db.toggleProxy(idB, true);
  });
});

describe("mass ip probe failure", () => {
  it("sends one ip_probe_system_down instead of an alert per proxy", async () => {
    db.saveCheck(idA, "up", 10, null);
    db.saveCheck(idB, "up", 10, null);
    vi.mocked(ip.fetchExternalIp).mockResolvedValue({ error: "Timeout" });

    await monitor.runIpChecks();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith("probe system down 2");
    expect(db.getLastSystemAlert("ip_probe")?.type).toBe("ip_probe_system_down");
    expect(db.getLastAlert(idA, "probe")).toBeUndefined();
    expect(db.getLastAlert(idB, "probe")).toBeUndefined();
  });

  it("sends ip_probe_system_ok when any proxy reports an IP again", async () => {
    db.saveCheck(idA, "up", 10, null);
    db.saveCheck(idB, "up", 10, null);
    vi.mocked(ip.fetchExternalIp).mockResolvedValue({ ip: "203.0.113.7" });

    await monitor.runIpChecks();

    expect(telegram.sendMessage).toHaveBeenCalledWith("probe system ok");
    expect(db.getLastSystemAlert("ip_probe")?.type).toBe("ip_probe_system_ok");
  });
});
