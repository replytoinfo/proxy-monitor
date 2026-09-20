/**
 * F2: Гонка /edit ↔ незавершённая проверка.
 * Результат проверки старого адреса не должен попасть в счётчики нового.
 * R1: stale-результат при удалении прокси → цикл неполный → mass_down не отправляется.
 * R3: смена пароля во время проверки → saveCheck не вызван (password входит в сравнение).
 * S1: stale-результат помечает цикл неполным → ложный mass_down не отправляется.
 * S4: прокси с паролем, ничего не менялось → saveCheck вызван (сравнение корректно).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
    CHECK_URL: "http://www.gstatic.com/generate_204",
    CHECK_URL_FALLBACK: null,
    IP_PROBE_FAIL_THRESHOLD: 3,
    HEALTHCHECK_URL: null,
    CHECKS_RETENTION_HOURS: 168,
    SPEED_URL: "http://speed.cloudflare.com/__down?bytes=1048576",
  },
}));

vi.mock("../checker/liveness.js", () => ({ checkWithFallback: vi.fn() }));
vi.mock("../telegram.js", () => ({
  sendMessage: vi.fn(async () => true),
  formatDownAlert: () => "down",
  formatReminderAlert: () => "reminder",
  formatRecoveryAlert: () => "recovery",
  formatStaleIpAlert: () => "stale",
  formatRotationOkAlert: () => "resumed",
  formatMassDownAlert: () => "mass_down",
  formatMassRecoveryAlert: () => "mass_recovery",
}));

const DB_FILE = join(tmpdir(), `pm-edit-race-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");
let monitor: typeof import("../monitor.js");
let liveness: typeof import("../checker/liveness.js");
let telegram: typeof import("../telegram.js");

beforeAll(async () => {
  db = await import("../db.js");
  monitor = await import("../monitor.js");
  liveness = await import("../checker/liveness.js");
  telegram = await import("../telegram.js");
});

afterAll(() => {
  monitor.stopMonitor();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

describe("R1: stale-результат при удалении прокси", () => {
  it("удалённая прокси не вызывает ложное mass_recovery и не порождает FK-ошибок", async () => {
    vi.mocked(telegram.sendMessage).mockClear();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Имитируем состояние mass_down
    db.saveSystemAlert("mass_down");

    // Два «живых» прокси (остаются в БД)
    const r1 = db.addProxy({ host: "mass-real-1.example", port: 7001, type: "http" });
    const r2 = db.addProxy({ host: "mass-real-2.example", port: 7002, type: "http" });
    const id1 = Number(r1.lastInsertRowid);
    const id2 = Number(r2.lastInsertRowid);

    // Прокси, которая будет удалена в процессе проверки
    const r3 = db.addProxy({ host: "mass-deleted.example", port: 7003, type: "http" });
    const id3 = Number(r3.lastInsertRowid);

    let releaseDeleted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseDeleted = resolve; });

    vi.mocked(liveness.checkWithFallback).mockReset();
    vi.mocked(liveness.checkWithFallback).mockImplementation(async (proxy) => {
      if ((proxy as { host: string }).host === "mass-deleted.example") {
        await gate;
        return { ok: true, responseTime: 100, usedFallback: false };
      }
      // Все остальные — down
      return { ok: false, responseTime: null, error: "timeout", usedFallback: false };
    });

    const checksBefore = db.getRecentChecks(id3, 10).length;
    const checkPromise = monitor.runChecks();

    // Удаляем прокси пока её проверка ещё выполняется
    db.deleteProxy(id3);

    releaseDeleted();
    await checkPromise;

    // Без исправления: mass-deleted возвращает «up» → handleMassOutage видит upCount=1
    // при last=mass_down → sendMessage("mass_recovery") вызывается (ложный алерт).
    // После исправления S1: stale-результат помечает цикл неполным →
    //   handleMassOutage пропускает цикл → mass_recovery НЕ отправлен.
    // Индивидуальные "down" для r1/r2 могут отправляться — это корректное поведение.
    expect(vi.mocked(telegram.sendMessage)).not.toHaveBeenCalledWith("mass_recovery");

    // Stale-обработка не должна порождать FK-ошибок («Proxy check failed»)
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Proxy check failed"),
      expect.anything()
    );

    // Строк в checks по удалённой прокси не прибавилось
    expect(db.getRecentChecks(id3, 10)).toHaveLength(checksBefore);

    errorSpy.mockRestore();

    // Cleanup
    db.deleteProxy(id1);
    db.deleteProxy(id2);
  });
});

describe("R3: смена пароля во время проверки", () => {
  it("/edit меняет только пароль во время проверки → saveCheck не вызван", async () => {
    const res = db.addProxy({
      host: "pass-change.example",
      port: 8888,
      type: "http",
      password: "old_pass",
    });
    const id = Number(res.lastInsertRowid);

    let releaseCheck!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCheck = resolve; });

    vi.mocked(liveness.checkWithFallback).mockReset();
    vi.mocked(liveness.checkWithFallback).mockImplementation(async (proxy) => {
      if ((proxy as { host: string }).host === "pass-change.example") {
        await gate;
        return { ok: true, responseTime: 150, usedFallback: false };
      }
      return { ok: true, responseTime: 100, usedFallback: false };
    });

    const checkPromise = monitor.runChecks();

    // Меняем пароль пока проверка висит
    db.updateProxyEndpoint(id, {
      host: "pass-change.example",
      port: 8888,
      type: "http",
      username: null,
      password: "new_pass",
    });

    releaseCheck();
    await checkPromise;

    // После смены пароля результат старой проверки устарел — saveCheck не должен вызываться.
    // Без R3-фикса: host/port/type/username не изменились → stale=false → saveCheck вызван.
    // После R3-фикса: пароль изменился → stale=true → saveCheck не вызван.
    const checks = db.getRecentChecks(id, 5);
    expect(checks).toHaveLength(0);
  });
});

describe("F2: гонка /edit ↔ проверка", () => {
  it("результат старой проверки не попадает в счётчики после /edit", async () => {
    const res = db.addProxy({ host: "old-race.example", port: 8080, type: "http" });
    const id = Number(res.lastInsertRowid);

    // Проверка зависает до завершения
    let releaseCheck!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCheck = resolve; });

    vi.mocked(liveness.checkWithFallback).mockImplementationOnce(async () => {
      await gate; // ждём updateProxyEndpoint
      return { ok: true, responseTime: 200, usedFallback: false };
    });

    // Запускаем цикл проверки (он зависнет на gate)
    const checkPromise = monitor.runChecks();

    // Пока проверка висит — меняем адрес прокси
    db.updateProxyEndpoint(id, {
      host: "new-race.example",
      port: 9090,
      type: "http",
      username: null,
      password: null,
    });

    // Отпускаем проверку
    releaseCheck();
    await checkPromise;

    // Счётчики нового адреса должны быть нулевыми (q_total=0 → не в getQualityAll)
    const q = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(q).toBeUndefined();

    // В таблице checks не должно быть новых записей после updateProxyEndpoint
    const checks = db.getRecentChecks(id, 10);
    expect(checks).toHaveLength(0);
  });
});

describe("S1: stale-результат → цикл неполный → mass_down не отправляется", () => {
  it("3 прокси: 2 down, 1 stale (отредактирована mid-check) → mass_down НЕ отправлен", async () => {
    vi.mocked(telegram.sendMessage).mockClear();

    const rA = db.addProxy({ host: "s1-a.example", port: 9001, type: "http" });
    const rB = db.addProxy({ host: "s1-b.example", port: 9002, type: "http" });
    const rC = db.addProxy({ host: "s1-c.example", port: 9003, type: "http" });
    const idA = Number(rA.lastInsertRowid);
    const idB = Number(rB.lastInsertRowid);
    const idC = Number(rC.lastInsertRowid);

    let releaseC!: () => void;
    const gate = new Promise<void>((resolve) => { releaseC = resolve; });

    vi.mocked(liveness.checkWithFallback).mockReset();
    vi.mocked(liveness.checkWithFallback).mockImplementation(async (proxy) => {
      if ((proxy as { host: string }).host === "s1-c.example") {
        await gate;
        return { ok: false, responseTime: null, error: "timeout", usedFallback: false };
      }
      return { ok: false, responseTime: null, error: "timeout", usedFallback: false };
    });

    const checkPromise = monitor.runChecks();

    // Редактируем прокси C пока её проверка ещё выполняется → её результат stale
    db.updateProxyEndpoint(idC, {
      host: "s1-c-new.example",
      port: 9003,
      type: "http",
      username: null,
      password: null,
    });

    releaseC();
    await checkPromise;

    // Stale делает цикл неполным → handleMassOutage пропускает → mass_down не отправлен
    expect(vi.mocked(telegram.sendMessage)).not.toHaveBeenCalledWith(
      expect.stringContaining("mass_down")
    );

    db.deleteProxy(idA);
    db.deleteProxy(idB);
    db.deleteProxy(idC);
  });
});

describe("S4: прокси с паролем — saveCheck вызван при отсутствии изменений", () => {
  it("пароль есть, ничего не менялось → 1 запись в checks, q_total=1", async () => {
    const res = db.addProxy({
      host: "s4-pass.example",
      port: 7777,
      type: "http",
      password: "secret123",
    });
    const id = Number(res.lastInsertRowid);

    vi.mocked(liveness.checkWithFallback).mockReset();
    vi.mocked(liveness.checkWithFallback).mockResolvedValue({
      ok: true,
      responseTime: 80,
      usedFallback: false,
    });

    await monitor.runChecks();

    // Если пароли сравниваются некорректно (шифртекст vs открытый текст),
    // стаел=true → saveCheck не вызывается → checks пуст.
    const checks = db.getRecentChecks(id, 5);
    expect(checks).toHaveLength(1);
    const quality = db.getQualityAll(168).find((r) => r.proxy_id === id);
    expect(quality?.total).toBe(1);

    db.deleteProxy(id);
  });
});
