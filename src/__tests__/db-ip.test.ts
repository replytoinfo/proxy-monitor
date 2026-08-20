import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
    IP_CHECK_INTERVAL: 300000,
    ROTATION_MAX_AGE: 2700000,
    IP_ECHO_URLS: ["http://api.ipify.org/"],
    CHECK_URL: "http://httpbin.org/status/200",
    CHECK_URL_FALLBACK: "http://www.gstatic.com/generate_204",
    IP_PROBE_FAIL_THRESHOLD: 3,
    HEALTHCHECK_URL: null,
  },
}));

const DB_FILE = join(tmpdir(), `pm-ip-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");
let proxyId: number;

beforeAll(async () => {
  db = await import("../db.js");
  const res = db.addProxy({ host: "example.com", port: 8080, type: "http" });
  proxyId = Number(res.lastInsertRowid);
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

describe("ip state", () => {
  it("returns undefined before the first observation", () => {
    expect(db.getIpState(proxyId)).toBeUndefined();
  });

  it("stores and updates state without touching the change log", () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    db.upsertIpState(proxyId, "1.2.3.4", db.toSqlTime(t0), db.toSqlTime(t0));
    expect(db.getIpState(proxyId)?.ip).toBe("1.2.3.4");

    const t1 = t0 + 600_000;
    db.upsertIpState(proxyId, "1.2.3.4", db.toSqlTime(t1), db.toSqlTime(t1));
    const state = db.getIpState(proxyId)!;
    expect(db.fromSqlTime(state.ip_since)).toBe(t1);
    expect(db.countIpChanges(proxyId, 24)).toBe(0);
  });
});

describe("ip changes", () => {
  it("counts changes within the window", () => {
    db.saveIpChange(proxyId, "5.6.7.8");
    db.saveIpChange(proxyId, "9.10.11.12");

    expect(db.countIpChanges(proxyId, 24)).toBe(2);
  });
});

describe("alerts split by kind", () => {
  it("does not mix rotation alerts into uptime lookups", () => {
    db.saveAlert(proxyId, "down");
    db.saveAlert(proxyId, "stale_ip");

    expect(db.getLastAlert(proxyId, "uptime")?.type).toBe("down");
    expect(db.getLastAlert(proxyId, "rotation")?.type).toBe("stale_ip");
  });
});
