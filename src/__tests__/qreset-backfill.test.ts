import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";

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
    SPEED_URL: "http://speed.cloudflare.com/__down?bytes=1048576",
  },
}));

const DB_FILE = join(tmpdir(), `pm-qreset-backfill-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

// Создаём БД со старой схемой (без q_* колонок) ДО загрузки db.ts.
// db.ts открывается в beforeAll и запускает миграции, в том числе бэкфилл.
{
  const raw = new BetterSqlite3(DB_FILE);
  raw.pragma("journal_mode = WAL");
  // Схема без q_* и без group_name — имитирует старую БД
  raw.exec(`
    CREATE TABLE proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'http',
      username TEXT,
      password TEXT,
      label TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proxy_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      response_time INTEGER,
      error TEXT,
      used_fallback INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  raw
    .prepare(`INSERT INTO proxies (host, port, type) VALUES ('backfill.example', 8080, 'http')`)
    .run();
  // 3 проверки: 2 up (один через fallback) + 1 down
  raw
    .prepare(
      `INSERT INTO checks (proxy_id, status, response_time, error, used_fallback) VALUES (1, 'up', 200, NULL, 0)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO checks (proxy_id, status, response_time, error, used_fallback) VALUES (1, 'down', 20000, 'timeout', 0)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO checks (proxy_id, status, response_time, error, used_fallback) VALUES (1, 'up', 150, NULL, 1)`
    )
    .run();
  raw.close();
}

let db: typeof import("../db.js");

beforeAll(async () => {
  db = await import("../db.js");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

describe("бэкфилл при миграции q_* колонок", () => {
  it("заполняет q_total, q_down, q_fallback, q_since из существующих checks", () => {
    const raw = db.default;
    const row = raw
      .prepare(
        `SELECT q_total, q_down, q_fallback, q_since FROM proxies WHERE id = 1`
      )
      .get() as { q_total: number; q_down: number; q_fallback: number; q_since: string | null };

    expect(row.q_total).toBe(3);
    expect(row.q_down).toBe(1);
    expect(row.q_fallback).toBe(1);
    expect(row.q_since).toBeTruthy(); // MIN(checked_at) заполнено
  });
});
