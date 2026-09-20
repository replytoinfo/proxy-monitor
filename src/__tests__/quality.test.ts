import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { formatSpanLabel } from "../quality-format.js";
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

  it("fallback не снижает quality — успех через запасной адрес считается up", () => {
    const id = freshProxy();
    for (let i = 0; i < 3; i++) db.saveCheck(id, "up", 200, null, false);
    db.saveCheck(id, "up", 10400, null, true);

    const row = db.getQualityAll(24).find((r) => r.proxy_id === id);

    expect(row?.quality).toBe(100);
    expect(row?.fallback).toBe(1);
    expect(row?.down).toBe(0);
  });

  it("прокси только с fallback-успехами и без DOWN даёт 100%", () => {
    const id = freshProxy();
    for (let i = 0; i < 5; i++) db.saveCheck(id, "up", 10000, null, true);

    const row = db.getQualityAll(24).find((r) => r.proxy_id === id);

    expect(row?.quality).toBe(100);
    expect(row?.fallback).toBe(5);
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

  it("down+fallback на одной проверке — один down, не снимает дважды", () => {
    const id = freshProxy();
    for (let i = 0; i < 3; i++) db.saveCheck(id, "up", 200, null, false);
    db.saveCheck(id, "down", 20000, "оба адреса недоступны", true);

    const row = db.getQualityAll(24).find((r) => r.proxy_id === id);

    expect(row?.quality).toBe(75);
    expect(row?.down).toBe(1);
    expect(row?.fallback).toBe(1);
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
         VALUES (?, 'down', 20000, 'прямая вставка', 1, datetime('now', '-30 hours'))`
      )
      .run(id);
    db.saveCheck(id, "up", 200, null, false);

    const row = db.getQualityWindow(24).find((r) => r.proxy_id === id);

    expect(row?.total).toBe(1);
    expect(row?.quality).toBe(100);
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

// ── F10: q_since устанавливается при первом saveCheck ─────────────────────────

describe("F10: q_since устанавливается при первом saveCheck, а не от created_at", () => {
  it("since ≈ сейчас, а не дата created_at в прошлом", () => {
    const id = freshProxy();
    // Устанавливаем created_at в прошлое через raw UPDATE
    db.default
      .prepare("UPDATE proxies SET created_at = '2020-01-01 00:00:00' WHERE id = ?")
      .run(id);

    db.saveCheck(id, "up", 200, null, false);

    const q = db.getQualityAll(168).find((r) => r.proxy_id === id);
    // since должно быть близко к сейчас, не 2020
    expect(q).toBeDefined();
    const sinceYear = new Date(q!.since + "Z").getFullYear();
    expect(sinceYear).toBeGreaterThanOrEqual(2026);
  });
});

// ── F3: Паузнутые прокси не в getQualityAll ───────────────────────────────────

describe("F3: паузнутые прокси отсутствуют в getQualityAll", () => {
  it("прокси с q_total>0 и enabled=0 отсутствует в getQualityAll", () => {
    const id = freshProxy();
    db.saveCheck(id, "up", 200, null, false);
    // Выключаем прокси
    db.toggleProxy(id, false);

    const q = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(q).toBeUndefined();
  });

  it("после resume прокси появляется в getQualityAll", () => {
    const id = freshProxy();
    db.saveCheck(id, "up", 200, null, false);
    db.toggleProxy(id, false);
    db.toggleProxy(id, true);

    const q = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(q).toBeDefined();
    expect(q?.total).toBe(1);
  });
});

// ── F8: getQualityAll() без аргумента — без медиан ───────────────────────────

describe("F8: getQualityAll() без аргумента не запрашивает медианы", () => {
  it("medianMs = null, quality посчитан", () => {
    const id = freshProxy();
    for (const ms of [100, 200, 300]) db.saveCheck(id, "up", ms, null, false);

    const row = db.getQualityAll().find((r) => r.proxy_id === id);
    expect(row).toBeDefined();
    expect(row!.quality).toBe(100);
    expect(row!.medianMs).toBeNull();
  });
});

// ── F3: resetQuality игнорирует since паузнутых прокси ───────────────────────

describe("F3: resetQuality() не учитывает since паузнутой прокси", () => {
  it("resetQuality() игнорирует since паузнутой прокси", () => {
    const a = freshProxy(); // активная
    const p = freshProxy(); // будет паузнута

    db.saveCheck(a, "up", 1, null, false);
    db.saveCheck(p, "up", 1, null, false);

    // Устанавливаем p.since раньше a.since — если паузнутая включается в MIN, вернётся 01.09
    db.default.prepare("UPDATE proxies SET q_since='2026-09-01 00:00:00' WHERE id=?").run(p);
    db.default.prepare("UPDATE proxies SET q_since='2026-09-10 00:00:00' WHERE id=?").run(a);

    db.toggleProxy(p, false);

    const prev = db.resetQuality();
    // MIN since из enabled прокси = 2026-09-10, не 2026-09-01
    expect(prev).toBe("2026-09-10 00:00:00");
  });
});

// ── R4: per-proxy span для подписи медианы ─────────────────────────────────

describe("R4: spanHours отражает фактический охват по каждой прокси", () => {
  it("прокси с 7д данных → spanHours=168, прокси с 30ч данных → spanHours=30", () => {
    // Используем окно 200ч, чтобы запись «ровно 168ч назад» вошла в выборку
    const WINDOW = 200;

    const id7d = freshProxy();
    const id30h = freshProxy();

    // Самая ранняя запись для id7d: 168 часов назад (ровно 7 дней)
    db.default
      .prepare(
        `INSERT INTO checks (proxy_id, status, response_time, error, used_fallback, checked_at)
         VALUES (?, 'up', 100, NULL, 0, datetime('now', '-168 hours'))`
      )
      .run(id7d);
    db.saveCheck(id7d, "up", 100, null, false);

    // Самая ранняя запись для id30h: 30 часов назад
    db.default
      .prepare(
        `INSERT INTO checks (proxy_id, status, response_time, error, used_fallback, checked_at)
         VALUES (?, 'up', 100, NULL, 0, datetime('now', '-30 hours'))`
      )
      .run(id30h);
    db.saveCheck(id30h, "up", 100, null, false);

    const rows = db.getQualityAll(WINDOW);
    const row7d = rows.find((r) => r.proxy_id === id7d);
    const row30h = rows.find((r) => r.proxy_id === id30h);

    // spanHours должен отражать реальный охват прокси, а не глобальный MIN
    expect(row7d?.spanHours).toBe(168);
    expect(row30h?.spanHours).toBe(30);

    // Форматтер даёт ожидаемые метки
    expect(formatSpanLabel(row7d!.spanHours!)).toBe("7д");
    expect(formatSpanLabel(row30h!.spanHours!)).toBe("1д");
  });
});
