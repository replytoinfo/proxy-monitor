import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

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
    CHECKS_RETENTION_HOURS: 168,
  },
}));

const DB_FILE = join(tmpdir(), `pm-stats-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");
let stats: typeof import("../stats-export.js");
let seq = 0;

function freshProxy(extra: { label?: string; username?: string; password?: string } = {}): number {
  seq += 1;
  const res = db.addProxy({
    host: `stats-${seq}.example`,
    port: 8000 + seq,
    type: "socks5",
    ...extra,
  });
  return Number(res.lastInsertRowid);
}

beforeAll(async () => {
  db = await import("../db.js");
  stats = await import("../stats-export.js");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_FILE}${suffix}`, { force: true });
});

describe("buildStats", () => {
  it("считает uptime и quality за окно и отдаёт медиану", () => {
    const id = freshProxy({ label: "T1" });
    for (const ms of [200, 220, 240]) db.saveCheck(id, "up", ms, null, false);
    db.saveCheck(id, "down", 20000, "timeout", false);

    const row = stats.buildStats(24, new Date("2026-09-03T12:00:00Z")).proxies.find((p) => p.id === id);

    expect(row).toMatchObject({
      label: "T1",
      host: `stats-${seq}.example`,
      port: 8000 + seq,
      type: "socks5",
      enabled: true,
      total: 4,
      down: 1,
      fallback: 0,
      uptime: 75,
      quality: 75,
      median_ms: 240,
    });
  });

  it("отдаёт null вместо NaN, когда проверок в окне нет", () => {
    const id = freshProxy();

    const row = stats.buildStats(24).proxies.find((p) => p.id === id);

    expect(row).toMatchObject({ total: 0, down: 0, fallback: 0, uptime: null, quality: null, median_ms: null });
  });

  it("не выдаёт логин и пароль прокси", () => {
    const id = freshProxy({ username: "user1", password: "secret1" });
    db.saveCheck(id, "up", 200, null, false);

    const json = JSON.stringify(stats.buildStats(24));

    expect(json).not.toContain("user1");
    expect(json).not.toContain("secret1");
    expect(json).not.toContain("username");
    expect(json).not.toContain("password");
  });

  it("ставит generated_at и window_hours", () => {
    const s = stats.buildStats(24, new Date("2026-09-03T12:00:00Z"));

    expect(s.generated_at).toBe("2026-09-03T12:00:00.000Z");
    expect(s.window_hours).toBe(24);
  });
});
