/**
 * F1: Атомарная и самовосстанавливаемая миграция q_*.
 * (б) Частичная схема: q_total без q_down/q_fallback/q_since → все 4 колонки после открытия.
 * (в) Повторное открытие мигрированной БД не обнуляет счётчики.
 * (backfill) q_since = created_at для 1.9.0-era строк с q_total>0 и q_since NULL.
 */
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
    CHECK_URL: "http://www.gstatic.com/generate_204",
    CHECK_URL_FALLBACK: null,
    IP_PROBE_FAIL_THRESHOLD: 3,
    HEALTHCHECK_URL: null,
    CHECKS_RETENTION_HOURS: 168,
    SPEED_URL: "http://speed.cloudflare.com/__down?bytes=1048576",
  },
}));

// БД с частичной схемой — только q_total, без q_down/q_fallback/q_since
const DB_FILE = join(tmpdir(), `pm-partial-migration-${process.pid}.db`);

{
  const raw = new BetterSqlite3(DB_FILE);
  raw.pragma("journal_mode = WAL");
  // Минимальная схема: только proxies с q_total (без q_down/q_fallback/q_since).
  // db.ts создаёт остальные таблицы через CREATE TABLE IF NOT EXISTS сам.
  raw.exec(`
    CREATE TABLE proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'http',
      username TEXT,
      password TEXT,
      label TEXT,
      group_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      q_total INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Прокси с уже заполненным q_total=5 (эмуляция живой системы до частичного апдейта)
  raw.prepare(`INSERT INTO proxies (host, port, type, q_total) VALUES ('partial.example', 8080, 'http', 5)`).run();
  raw.close();
}

process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");

beforeAll(async () => {
  db = await import("../db.js");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

describe("F1(б): частичная схема — только q_total", () => {
  it("все 4 q_* колонки присутствуют после открытия", () => {
    const raw = db.default;
    const cols = new Set(
      (raw.pragma("table_info(proxies)") as Array<{ name: string }>).map((c) => c.name)
    );
    expect(cols.has("q_total")).toBe(true);
    expect(cols.has("q_down")).toBe(true);
    expect(cols.has("q_fallback")).toBe(true);
    expect(cols.has("q_since")).toBe(true);
  });

  it("q_total пересчитан из checks (частичная миграция → полный пересчёт)", () => {
    const raw = db.default;
    const row = raw
      .prepare("SELECT q_total FROM proxies WHERE id = 1")
      .get() as { q_total: number };
    // S2: при любой частичной миграции все 4 q_* пересчитываются из checks.
    // checks пусты → q_total=0 (согласовано с другими счётчиками).
    expect(row.q_total).toBe(0);
  });

  it("backfill: q_since = created_at для строк с q_total>0 и q_since NULL", () => {
    const raw = db.default;
    const row = raw
      .prepare("SELECT q_since, created_at FROM proxies WHERE id = 1")
      .get() as { q_since: string; created_at: string };
    expect(row.q_since).toBe(row.created_at);
  });
});

// ── R2: частичная миграция — q_total присутствует, остальные отсутствуют, checks есть ──────────

{
  const DB_FILE_R2 = join(tmpdir(), `pm-partial-r2-${process.pid}.db`);

  {
    const raw2 = new BetterSqlite3(DB_FILE_R2);
    raw2.pragma("journal_mode = WAL");
    raw2.exec(`
      CREATE TABLE proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'http',
        username TEXT,
        password TEXT,
        label TEXT,
        group_name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        q_total INTEGER NOT NULL DEFAULT 0
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
    const r = raw2.prepare(`INSERT INTO proxies (host, port, type) VALUES ('r2-backfill.example', 8080, 'http')`).run();
    const id = r.lastInsertRowid;
    raw2.prepare(`INSERT INTO checks (proxy_id, status, response_time, used_fallback) VALUES (?, 'up', 100, 0)`).run(id);
    raw2.prepare(`INSERT INTO checks (proxy_id, status, response_time, used_fallback) VALUES (?, 'down', null, 0)`).run(id);
    raw2.prepare(`INSERT INTO checks (proxy_id, status, response_time, used_fallback) VALUES (?, 'up', 200, 1)`).run(id);
    raw2.close();
  }

  describe("R2: частичная схема + checks → бэкфилл q_total/q_down/q_fallback/q_since", () => {
    let db2: typeof import("../db.js");

    beforeAll(async () => {
      vi.resetModules();
      process.env.DB_PATH = DB_FILE_R2;
      db2 = await import("../db.js");
    });

    afterAll(() => {
      process.env.DB_PATH = DB_FILE;
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${DB_FILE_R2}${suffix}`, { force: true });
      }
    });

    it("q_total, q_down, q_fallback бэкфиллятся из checks при частичной миграции", () => {
      const row = db2.default
        .prepare("SELECT q_total, q_down, q_fallback, q_since FROM proxies WHERE id = 1")
        .get() as { q_total: number; q_down: number; q_fallback: number; q_since: string };
      // 3 записей в checks: 2 up (один с fallback=1), 1 down
      expect(row.q_total).toBe(3);
      expect(row.q_down).toBe(1);
      expect(row.q_fallback).toBe(1);
      expect(row.q_since).not.toBeNull();
    });
  });
}

describe("F1(в): повторное открытие не трогает счётчики", () => {
  it("все колонки присутствуют при повторном открытии, q_total стабилен", async () => {
    vi.resetModules();
    const db2 = await import("../db.js");
    const row = db2.default
      .prepare("SELECT q_total FROM proxies WHERE id = 1")
      .get() as { q_total: number };
    // После первого открытия q_total=0 (пересчитан из пустых checks); второе открытие не меняет.
    expect(row.q_total).toBe(0);
    const cols = new Set(
      (db2.default.pragma("table_info(proxies)") as Array<{ name: string }>).map((c) => c.name)
    );
    expect(["q_total", "q_down", "q_fallback", "q_since"].every((c) => cols.has(c))).toBe(true);
  });
});

// ── S2: неполная миграция с q_total/q_down/q_fallback, q_since отсутствует ──────────────────────
// Если любая из q_*-колонок отсутствовала, все четыре пересчитываются из checks.
// Это означает, что q_total=100/q_down=20 (старые накопленные счётчики) будут заменены
// актуальными значениями из 5 записей checks (1 down) → q_total=5, q_down=1.

{
  const DB_FILE_S2 = join(tmpdir(), `pm-partial-s2-${process.pid}.db`);

  {
    const rawS2 = new BetterSqlite3(DB_FILE_S2);
    rawS2.pragma("journal_mode = WAL");
    rawS2.exec(`
      CREATE TABLE proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'http',
        username TEXT,
        password TEXT,
        label TEXT,
        group_name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        q_total INTEGER NOT NULL DEFAULT 0,
        q_down  INTEGER NOT NULL DEFAULT 0,
        q_fallback INTEGER NOT NULL DEFAULT 0
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
    // Прокси со «старыми» накопленными счётчиками (q_since отсутствует как колонка)
    const rS2 = rawS2.prepare(
      `INSERT INTO proxies (host, port, type, q_total, q_down, q_fallback) VALUES ('s2-partial.example', 8080, 'http', 100, 20, 5)`
    ).run();
    const idS2 = rS2.lastInsertRowid;
    // 5 записей в checks: 4 up, 1 down
    for (let i = 0; i < 4; i++) {
      rawS2.prepare(
        `INSERT INTO checks (proxy_id, status, response_time, used_fallback, checked_at)
         VALUES (?, 'up', 100, 0, datetime('now', '-${i+1} minutes'))`
      ).run(idS2);
    }
    rawS2.prepare(
      `INSERT INTO checks (proxy_id, status, response_time, used_fallback, checked_at)
       VALUES (?, 'down', null, 0, datetime('now', '-10 minutes'))`
    ).run(idS2);
    rawS2.close();
  }

  describe("S2: q_total/q_down/q_fallback есть, q_since отсутствует → все 4 пересчитываются из checks", () => {
    let dbS2: typeof import("../db.js");

    beforeAll(async () => {
      vi.resetModules();
      process.env.DB_PATH = DB_FILE_S2;
      dbS2 = await import("../db.js");
    });

    afterAll(() => {
      process.env.DB_PATH = DB_FILE;
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${DB_FILE_S2}${suffix}`, { force: true });
      }
    });

    it("q_total=5 (из checks, не 100), q_down=1 (из checks, не 20)", () => {
      const row = dbS2.default
        .prepare("SELECT q_total, q_down, q_fallback, q_since FROM proxies WHERE id = 1")
        .get() as { q_total: number; q_down: number; q_fallback: number; q_since: string };
      expect(row.q_total).toBe(5);
      expect(row.q_down).toBe(1);
      expect(row.q_since).not.toBeNull();
    });

    it("q_since = MIN(checked_at) из checks", () => {
      const row = dbS2.default
        .prepare("SELECT q_since FROM proxies WHERE id = 1")
        .get() as { q_since: string };
      const minCheckedAt = dbS2.default
        .prepare("SELECT MIN(checked_at) as min_at FROM checks WHERE proxy_id = 1")
        .get() as { min_at: string };
      expect(row.q_since).toBe(minCheckedAt.min_at);
    });
  });
}
