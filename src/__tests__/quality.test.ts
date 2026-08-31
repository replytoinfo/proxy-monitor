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
    CHECKS_RETENTION_HOURS: 168,
  },
}));

const DB_FILE = join(tmpdir(), `pm-quality-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");
let seq = 0;

/** Свой прокси на каждый тест — изоляция без тест-специфичного кода в db.ts. */
function freshProxy(): number {
  seq += 1;
  const res = db.addProxy({ host: `quality-${seq}.example`, port: 8000 + seq, type: "socks5" });
  return Number(res.lastInsertRowid);
}

beforeAll(async () => {
  db = await import("../db.js");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

describe("getQualityAll", () => {
  it("даёт 100% когда все проверки успешны и ни одна не ушла в fallback", () => {
    const id = freshProxy();
    for (let i = 0; i < 5; i++) db.saveCheck(id, "up", 200, null, false);

    const row = db.getQualityAll(24).find((r) => r.proxy_id === id);

    expect(row?.quality).toBe(100);
  });

  it("считает сбоем успех через запасной адрес", () => {
    const id = freshProxy();
    for (let i = 0; i < 3; i++) db.saveCheck(id, "up", 200, null, false);
    db.saveCheck(id, "up", 10400, null, true);

    const row = db.getQualityAll(24).find((r) => r.proxy_id === id);

    expect(row?.quality).toBe(75);
    expect(row?.fallback).toBe(1);
    expect(row?.down).toBe(0);
  });

  it("считает сбоем недоступность", () => {
    const id = freshProxy();
    for (let i = 0; i < 3; i++) db.saveCheck(id, "up", 200, null, false);
    db.saveCheck(id, "down", 20000, "timeout", false);

    const row = db.getQualityAll(24).find((r) => r.proxy_id === id);

    expect(row?.quality).toBe(75);
    expect(row?.down).toBe(1);
  });

  it("не считает дважды проверку, которая и упала, и ходила в fallback", () => {
    const id = freshProxy();
    for (let i = 0; i < 3; i++) db.saveCheck(id, "up", 200, null, false);
    db.saveCheck(id, "down", 20000, "оба адреса недоступны", true);

    const row = db.getQualityAll(24).find((r) => r.proxy_id === id);

    expect(row?.quality).toBe(75);
  });

  it("не показывает прокси, у которой нет проверок в окне", () => {
    const id = freshProxy();

    const row = db.getQualityAll(24).find((r) => r.proxy_id === id);

    expect(row).toBeUndefined();
  });

  it("не учитывает проверки старше окна", async () => {
    const id = freshProxy();
    const raw = (await import("../db.js")).default;
    raw
      .prepare(
        `INSERT INTO checks (proxy_id, status, response_time, error, used_fallback, checked_at)
         VALUES (?, 'down', 20000, 'старая', 1, datetime('now', '-30 hours'))`
      )
      .run(id);
    db.saveCheck(id, "up", 200, null, false);

    const row = db.getQualityAll(24).find((r) => r.proxy_id === id);

    expect(row?.total).toBe(1);
    expect(row?.quality).toBe(100);
  });

  it("сообщает фактический охват истории, а не длину окна", async () => {
    const id = freshProxy();
    const raw = (await import("../db.js")).default;
    raw
      .prepare(
        `INSERT INTO checks (proxy_id, status, response_time, error, used_fallback, checked_at)
         VALUES (?, 'up', 200, NULL, 0, datetime('now', '-50 hours'))`
      )
      .run(id);

    expect(db.getChecksSpanHours(168)).toBe(50);
  });

  it("даёт медиану отклика, устойчивую к выбросам таймаутов", () => {
    const id = freshProxy();
    for (const ms of [200, 220, 240, 260, 10000]) {
      db.saveCheck(id, "up", ms, null, ms > 9000);
    }

    const row = db.getQualityAll(24).find((r) => r.proxy_id === id);

    expect(row?.medianMs).toBe(240);
  });
});
