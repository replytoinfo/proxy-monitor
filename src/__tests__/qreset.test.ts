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

const DB_FILE = join(tmpdir(), `pm-qreset-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");
let telegram: typeof import("../telegram.js");
let seq = 0;

function freshProxy(): number {
  seq++;
  const res = db.addProxy({
    host: `qreset-${seq}.example`,
    port: 8100 + seq,
    type: "socks5",
  });
  return Number(res.lastInsertRowid);
}

/** Возвращает текст последнего вызова sendMessage из захваченных вызовов fetch. */
function lastSendText(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  const calls = fetchMock.mock.calls as Array<[string, { body?: string }]>;
  const sendCall = [...calls]
    .reverse()
    .find(([url]) => String(url).includes("sendMessage"));
  if (!sendCall) return undefined;
  return JSON.parse(sendCall[1].body ?? "{}").text as string;
}

beforeAll(async () => {
  db = await import("../db.js");
  telegram = await import("../telegram.js");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    text: async () => "",
  });
  vi.stubGlobal("fetch", fetchMock);
});

// ── счётчики ─────────────────────────────────────────────────────────────────

describe("saveCheck обновляет счётчики прокси", () => {
  it("up: q_total+1, q_down и q_fallback не трогает", () => {
    const id = freshProxy();
    db.saveCheck(id, "up", 200, null, false);

    const q = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(q?.total).toBe(1);
    expect(q?.down).toBe(0);
    expect(q?.fallback).toBe(0);
    expect(q?.quality).toBe(100);
  });

  it("down: q_total+1, q_down+1", () => {
    const id = freshProxy();
    db.saveCheck(id, "down", null, "timeout", false);
    db.saveCheck(id, "up", 100, null, false);

    const q = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(q?.total).toBe(2);
    expect(q?.down).toBe(1);
    expect(q?.quality).toBe(50);
  });

  it("fallback=true: q_fallback+1, качество не снижается", () => {
    const id = freshProxy();
    db.saveCheck(id, "up", 10000, null, true);

    const q = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(q?.fallback).toBe(1);
    expect(q?.quality).toBe(100);
  });
});

// ── resetQuality ──────────────────────────────────────────────────────────────

describe("resetQuality", () => {
  it("сбрасывает счётчики всех прокси и возвращает прежнее since", () => {
    const id = freshProxy();
    db.saveCheck(id, "up", 200, null, false);
    db.saveCheck(id, "down", null, "err", false);
    // Устанавливаем известную дату
    db.default
      .prepare("UPDATE proxies SET q_since = '2026-09-14 10:00:00' WHERE id = ?")
      .run(id);

    const prevSince = db.resetQuality();

    // Должно вернуть что-то (минимальное since среди всех прокси)
    expect(prevSince).toBeTruthy();

    // Счётчики этой прокси обнулены — не появляется в списке
    const q = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(q).toBeUndefined();
  });

  it("resetQuality(id) обнуляет только одну прокси", () => {
    const id1 = freshProxy();
    const id2 = freshProxy();
    db.saveCheck(id1, "up", 200, null, false);
    db.saveCheck(id1, "up", 200, null, false);
    db.saveCheck(id2, "up", 300, null, false);

    db.resetQuality(id1);

    const all = db.getQualityAll(168);
    const q1 = all.find((r) => r.proxy_id === id1);
    const q2 = all.find((r) => r.proxy_id === id2);

    expect(q1).toBeUndefined(); // q_total=0, отфильтрована
    expect(q2?.total).toBe(1); // не тронута
  });
});

// ── getQualityAll из счётчиков ─────────────────────────────────────────────

describe("getQualityAll читает счётчики из proxies", () => {
  it("возвращает quality даже после удаления строк из checks (эмуляция retention)", () => {
    const id = freshProxy();
    db.saveCheck(id, "up", 200, null, false);
    db.saveCheck(id, "down", null, "err", false);

    // Удаляем все checks — имитируем истёкшее retention-окно
    db.default.prepare("DELETE FROM checks WHERE proxy_id = ?").run(id);

    const q = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(q?.total).toBe(2);
    expect(q?.down).toBe(1);
    expect(q?.quality).toBe(50);
    // медианы нет — checks пустые
    expect(q?.medianMs).toBeNull();
  });

  it("прокси с q_total=0 не появляется в списке", () => {
    const id = freshProxy();
    const q = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(q).toBeUndefined();
  });
});

// ── /qreset команда ───────────────────────────────────────────────────────────

describe("/qreset команда", () => {
  it("ответ содержит «сброшен» и предыдущую дату", async () => {
    const id = freshProxy();
    db.saveCheck(id, "up", 200, null, false);
    db.default
      .prepare("UPDATE proxies SET q_since = '2026-09-14 10:00:00' WHERE id = ?")
      .run(id);

    await telegram.handleCommand("12345", "/qreset");

    const text = lastSendText(fetchMock);
    expect(text).toContain("сброшен");
    expect(text).toMatch(/14\.09/);
  });
});

// ── /quality заголовок и медиана ──────────────────────────────────────────────

describe("/quality заголовок", () => {
  it("содержит «Качество с DD.MM (N дн.)»", async () => {
    const id = freshProxy();
    db.saveCheck(id, "up", 200, null, false);
    db.default
      .prepare("UPDATE proxies SET q_since = '2026-09-10 00:00:00' WHERE id = ?")
      .run(id);

    await telegram.handleCommand("12345", "/quality");

    const text = lastSendText(fetchMock);
    expect(text).toMatch(/Качество с \d{2}\.\d{2} \(\d+ дн\.\)/);
  });

  it("подпись медианы содержит число дней «Nд»", async () => {
    const id = freshProxy();
    for (const ms of [100, 200, 300]) db.saveCheck(id, "up", ms, null, false);

    await telegram.handleCommand("12345", "/quality");

    const text = lastSendText(fetchMock);
    // "медиана 7д 200ms" — число дней retention
    expect(text).toMatch(/медиана \d+д \d+ms/);
  });

  it("суффикс «с DD.MM» не ставится при одинаковой дате (разница в секундах)", async () => {
    const id1 = freshProxy();
    const id2 = freshProxy();
    db.saveCheck(id1, "up", 200, null, false);
    db.saveCheck(id2, "up", 200, null, false);
    db.default.prepare("UPDATE proxies SET q_since = '2026-09-10 00:00:00' WHERE id = ?").run(id1);
    db.default.prepare("UPDATE proxies SET q_since = '2026-09-10 00:00:05' WHERE id = ?").run(id2);

    await telegram.handleCommand("12345", "/quality");

    const text = lastSendText(fetchMock);
    // Оба прокси с 10.09 — суффикс в строке прокси («% с DD.MM») не должен появляться
    expect(text).not.toContain("% с 10.09");
  });

  it("суффикс «с DD.MM» ставится при разных датах", async () => {
    const id1 = freshProxy();
    const id2 = freshProxy();
    db.saveCheck(id1, "up", 200, null, false);
    db.saveCheck(id2, "up", 200, null, false);
    db.default.prepare("UPDATE proxies SET q_since = '2026-09-10 00:00:00' WHERE id = ?").run(id1);
    db.default.prepare("UPDATE proxies SET q_since = '2026-09-11 00:00:00' WHERE id = ?").run(id2);

    await telegram.handleCommand("12345", "/quality");

    const text = lastSendText(fetchMock);
    expect(text).toContain(" с 11.09");
  });
});

// ── /edit сбрасывает счётчики прокси ─────────────────────────────────────────

describe("/edit сбрасывает счётчики прокси", () => {
  it("после /edit счётчики обнуляются для изменённой прокси", async () => {
    const id = freshProxy();
    db.saveCheck(id, "up", 200, null, false);
    db.saveCheck(id, "down", null, "err", false);

    // Убеждаемся, что есть данные
    const before = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(before?.total).toBe(2);

    // Вызываем /edit через команду
    await telegram.handleCommand("12345", `/edit\n${id}\nnew-qreset.example:9090`);

    const after = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(after).toBeUndefined(); // q_total=0 после сброса
  });
});

// ── /list хвост из счётчиков ─────────────────────────────────────────────────

describe("/list показывает хвост качества из счётчиков", () => {
  it("хвост «· N%» присутствует для прокси с данными", async () => {
    const id = freshProxy();
    for (let i = 0; i < 3; i++) db.saveCheck(id, "up", 200, null, false);
    db.saveCheck(id, "down", null, "err", false); // 75%

    // Удаляем checks — только счётчики должны остаться
    db.default.prepare("DELETE FROM checks WHERE proxy_id = ?").run(id);

    await telegram.handleCommand("12345", "/list");

    const text = lastSendText(fetchMock);
    // /list должен показать «· 75%» из счётчиков
    expect(text).toContain("· 75%");
  });
});
