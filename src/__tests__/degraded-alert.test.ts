/**
 * Алерт деградации в связке с монитором, БД и командами бота.
 * Telegram настоящий, сеть подменена fetch-заглушкой; проверки живости — моки.
 */
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
    ALLOW_PRIVATE_TARGETS: true,
    ENCRYPTION_KEY: "a".repeat(64),
    REMINDER_INTERVAL: 0,
    IP_CHECK_INTERVAL: 315000,
    ROTATION_MAX_AGE: 2700000,
    IP_ECHO_URLS: ["http://api.ipify.org/"],
    CHECK_URL: "http://httpbin.org/status/200",
    CHECK_URL_FALLBACK: "http://www.gstatic.com/generate_204",
    IP_PROBE_FAIL_THRESHOLD: 3,
    HEALTHCHECK_URL: null,
    CHECKS_RETENTION_HOURS: 168,
    DEGRADED_WINDOW_MIN: 15,
    DEGRADED_SLOW_MS: 5000,
    DEGRADED_MIN_CHECKS: 10,
    DEGRADED_RATIO: 0.3,
    DEGRADED_RECOVER_RATIO: 0.1,
  },
}));

vi.mock("../checker/liveness.js", () => ({ checkWithFallback: vi.fn() }));
vi.mock("../checker/ip.js", () => ({ fetchExternalIp: vi.fn() }));

const DB_FILE = join(tmpdir(), `pm-degraded-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");
let monitor: typeof import("../monitor.js");
let telegram: typeof import("../telegram.js");
let liveness: typeof import("../checker/liveness.js");
let config: (typeof import("../config.js"))["config"];
let fetchMock: ReturnType<typeof vi.fn>;
let seq = 0;

beforeAll(async () => {
  db = await import("../db.js");
  monitor = await import("../monitor.js");
  telegram = await import("../telegram.js");
  liveness = await import("../checker/liveness.js");
  config = (await import("../config.js")).config;
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_FILE}${suffix}`, { force: true });
});

beforeEach(() => {
  // Каждый тест на чистой базе: лишние прокси получали бы проверки и мусорили в подсчётах.
  for (const p of db.getProxies()) db.deleteProxy(p.id);
  db.default.exec("DELETE FROM system_alerts");
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
  vi.stubGlobal("fetch", fetchMock);
  config.DEGRADED_WINDOW_MIN = 15;
  vi.mocked(liveness.checkWithFallback).mockReset();
  cycleResult({ ok: true, ms: 100 });
});

// --- помощники ---

function cycleResult(r: { ok: boolean; ms: number }) {
  vi.mocked(liveness.checkWithFallback).mockResolvedValue({
    ok: r.ok,
    responseTime: r.ms,
    error: r.ok ? undefined : "Timeout",
    usedFallback: false,
  });
}

function freshProxy(label = "DE1"): number {
  seq++;
  return Number(
    db.addProxy({ host: `degraded-${seq}.example.com`, port: 9000 + seq, type: "http", label })
      .lastInsertRowid
  );
}

const sql = (minutesAgo: number) => db.toSqlTime(Date.now() - minutesAgo * 60_000);

/**
 * Равномерно раскладывает проверки на отрезке от 14 до 1 минуты назад (первая — самая старая).
 * shiftMin сдвигает отрезок в прошлое; shiftMin = -15 уводит его целиком в будущее
 * относительно «сейчас», то есть после любой метки, поставленной в начале теста.
 */
function seed(id: number, spec: { ok?: number; slow?: number; fail?: number }, shiftMin = 0) {
  const kinds: Array<[string, number]> = [
    ...Array.from({ length: spec.fail ?? 0 }, (): [string, number] => ["down", 10_500]),
    ...Array.from({ length: spec.slow ?? 0 }, (): [string, number] => ["up", 7_000]),
    ...Array.from({ length: spec.ok ?? 0 }, (): [string, number] => ["up", 300]),
  ];
  // перемешиваем детерминированно, чтобы плохие не лежали сплошным куском
  const mixed = kinds.map((k, i) => ({ k, key: (i * 7919) % kinds.length }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.k);
  const ins = db.default.prepare(
    "INSERT INTO checks (proxy_id, status, response_time, checked_at) VALUES (?, ?, ?, ?)"
  );
  mixed.forEach(([status, rt], i) => {
    const age = 14 - i * (13 / Math.max(1, mixed.length - 1));
    ins.run(id, status, rt, sql(age + shiftMin));
  });
}

function alertAt(id: number, type: string, minutesAgo: number) {
  db.default
    .prepare("INSERT INTO alerts (proxy_id, type, sent_at) VALUES (?, ?, ?)")
    .run(id, type, sql(minutesAgo));
}

const sent = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body).text as string);
const degradedMsgs = () => sent().filter((t) => t.includes("Прокси деградирует"));
const recoveredMsgs = () => sent().filter((t) => t.includes("Деградация прошла"));
const recoveryRows = (id: number) =>
  (db.default
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE proxy_id = ? AND type = 'degraded_recovery'")
    .get(id) as { n: number }).n;
const lastState = (id: number) => db.getLastAlert(id, "degraded")?.type;

const CHAT = "12345";

// --- правило ---

describe("срабатывание", () => {
  it("меньше 10 проверок в окне — молчит, даже если все плохие", async () => {
    const id = freshProxy();
    seed(id, { slow: 8 }); // + 1 проверка цикла = 9; медленные — это up, цепочка DOWN не копится
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
  });

  it("5 плохих из 20 (25%) — молчит, 6 из 20 (30%) — алерт", async () => {
    const quiet = freshProxy("Q");
    seed(quiet, { ok: 14, fail: 3, slow: 2 }); // 19 + цикл(ok) = 20, плохих 5
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);

    const loud = freshProxy("L");
    seed(loud, { ok: 13, fail: 3, slow: 3 }); // плохих 6 из 20
    await monitor.runChecks();
    expect(degradedMsgs().filter((t) => t.includes("L"))).toHaveLength(1);
    expect(lastState(loud)).toBe("degraded");
  });

  it("текст: имя, доля, отказы/медленные, медиана и p90", async () => {
    const id = freshProxy("DE1");
    seed(id, { ok: 8, fail: 3, slow: 5 });
    await monitor.runChecks();
    const [msg] = degradedMsgs();
    expect(msg).toContain("DE1");
    expect(msg).toContain(`degraded-${seq}.example.com:${9000 + seq}`);
    expect(msg).toContain("8 из 17"); // 3 отказа + 5 медленных; 16 проверок + проверка цикла
    expect(msg).toContain("(47%)");
    expect(msg).toContain("3 отказа");
    expect(msg).toContain("5 медленнее 5 с");
    expect(msg).toMatch(/медиана \d+ мс, p90 \d+ мс/);
  });

  it("медленный успех (отклик выше порога) — плохая проверка", async () => {
    const id = freshProxy();
    seed(id, { ok: 13, slow: 6 }); // «slow» = up с откликом 7000, как успех после таймаута основного
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(1);
  });

  it("повторного алерта в следующем цикле нет", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    await monitor.runChecks();
    await monitor.runChecks();
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(1);
    expect(lastState(id)).toBe("degraded");
  });

  it("паузнутая прокси не оценивается", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    db.toggleProxy(id, false);
    await monitor.runChecks();
    expect(sent()).toHaveLength(0);
  });

  it("DEGRADED_WINDOW_MIN=0 выключает алерт", async () => {
    config.DEGRADED_WINDOW_MIN = 0;
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
  });

  it("проверки старше окна не учитываются", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 }, 30); // всё 30+ минут назад
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
  });

  it("неудачная отправка не сохраняет состояние — следующий цикл повторит", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "bad" });
    await monitor.runChecks();
    expect(lastState(id)).toBeUndefined();

    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    await monitor.runChecks();
    expect(lastState(id)).toBe("degraded");
  });
});

describe("восстановление", () => {
  it("между порогами (20%) деградация держится, ниже 10% — снимается с длительностью", async () => {
    const id = freshProxy();
    alertAt(id, "degraded", 65);
    seed(id, { ok: 15, fail: 4 }); // 19 + цикл = 20, плохих 4 = 20%
    await monitor.runChecks();
    expect(recoveredMsgs()).toHaveLength(0);
    expect(lastState(id)).toBe("degraded");

    const id2 = freshProxy("OK");
    alertAt(id2, "degraded", 65);
    seed(id2, { ok: 18, fail: 1 }); // 1 из 20 = 5%
    await monitor.runChecks();
    const [msg] = recoveredMsgs();
    expect(msg).toContain("OK");
    expect(msg).toMatch(/1 ч 5 мин/);
    expect(lastState(id2)).toBe("degraded_recovery");
  });

  it("после восстановления новая деградация снова даёт алерт", async () => {
    const id = freshProxy();
    alertAt(id, "degraded", 120);
    alertAt(id, "degraded_recovery", 60);
    seed(id, { ok: 8, fail: 6, slow: 5 });
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(1);
  });
});

describe("рестарт процесса", () => {
  it("состояние берётся из alerts: после рестарта повторного алерта нет, восстановление работает", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(1);

    // «рестарт»: модули грузятся заново, in-memory состояния нет
    vi.resetModules();
    const monitor2 = await import("../monitor.js");
    const liveness2 = await import("../checker/liveness.js");
    vi.mocked(liveness2.checkWithFallback).mockResolvedValue({
      ok: false, responseTime: 10_000, error: "Timeout", usedFallback: false,
    });
    await monitor2.runChecks();
    expect(degradedMsgs()).toHaveLength(1);

    // окно очистилось — fresh-модуль видит открытую деградацию и закрывает её
    db.default.prepare("DELETE FROM checks WHERE proxy_id = ?").run(id);
    seed(id, { ok: 18 });
    vi.mocked(liveness2.checkWithFallback).mockResolvedValue({
      ok: true, responseTime: 100, usedFallback: false,
    });
    await monitor2.runChecks();
    expect(recoveredMsgs()).toHaveLength(1);
  });
});

describe("взаимодействие с DOWN", () => {
  it("активный DOWN подавляет деградацию", async () => {
    const id = freshProxy();
    alertAt(id, "down", 3);
    seed(id, { ok: 8, fail: 6, slow: 5 });
    cycleResult({ ok: false, ms: 10_000 }); // и в цикле прокси остаётся down
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
  });

  it("после DOWN→RECOVERED хвост DOWN-эпизода деградацию не даёт (окно с момента recovery)", async () => {
    const id = freshProxy();
    seed(id, { ok: 4, fail: 14 }); // 14 отказов подряд -> был DOWN
    alertAt(id, "down", 10);
    alertAt(id, "recovery", 0.1);
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
    expect(sent().filter((t) => t.includes("DOWN"))).toHaveLength(0);
  });

  it("деградация → DOWN → RECOVERED при всё ещё плохом окне: повторного DEGRADED нет", async () => {
    const id = freshProxy();
    alertAt(id, "degraded", 60);
    alertAt(id, "down", 40);
    alertAt(id, "recovery", 15);
    seed(id, { ok: 6, fail: 4, slow: 3 }); // после recovery: 13 + цикл = 14, плохих 7 = 50%
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
    expect(recoveredMsgs()).toHaveLength(0);
    expect(lastState(id)).toBe("degraded");
  });

  it("деградация, пережившая DOWN, закрывается после выздоровления", async () => {
    const id = freshProxy();
    alertAt(id, "degraded", 60);
    alertAt(id, "down", 40);
    alertAt(id, "recovery", 15);
    seed(id, { ok: 18 });
    await monitor.runChecks();
    expect(recoveredMsgs()).toHaveLength(1);
  });

  it("массовый сбой монитора (mass_down) деградацию не оценивает", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    db.saveSystemAlert("mass_down");
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
  });

  it("после mass_recovery окно начинается с него: проверки сбоя не в счёт", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    db.saveSystemAlert("mass_down");
    db.saveSystemAlert("mass_recovery");
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
  });
});

describe("команды бота", () => {
  it("/edit: старые плохие проверки на новом устройстве не дают DEGRADED, открытая деградация закрывается молча", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    alertAt(id, "degraded", 20);
    alertAt(id, "down", 25);

    await telegram.handleCommand(CHAT, `/edit ${id}\nnew-host.example.com:8080`);
    expect(lastState(id)).toBe("degraded_recovery");
    expect(db.getLastAlert(id, "uptime")?.type).toBe("recovery"); // маркер вместо ложного RECOVERED
    fetchMock.mockClear();

    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
    expect(recoveredMsgs()).toHaveLength(0);
  });

  it("/edit: плохие проверки уже ПОСЛЕ замены дают DEGRADED", async () => {
    const id = freshProxy();
    seed(id, { ok: 20 });
    await telegram.handleCommand(CHAT, `/edit ${id}\nnew-host.example.com:8080`);
    fetchMock.mockClear();

    seed(id, { ok: 8, fail: 6, slow: 5 }, -15); // после метки window_reset
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(1);
  });

  it("/edit без открытой деградации не создаёт маркера degraded_recovery", async () => {
    const id = freshProxy();
    await telegram.handleCommand(CHAT, `/edit ${id}\nnew-host.example.com:8080`);
    expect(lastState(id)).toBeUndefined();
  });

  it("/pause закрывает открытую деградацию молча; после /resume оценка идёт с нуля", async () => {
    const id = freshProxy();
    alertAt(id, "degraded", 20);
    await telegram.handleCommand(CHAT, `/pause ${id}`);
    expect(lastState(id)).toBe("degraded_recovery");
    expect(sent().filter((t) => t.includes("Деградация"))).toHaveLength(0);

    await telegram.handleCommand(CHAT, `/resume ${id}`);
    seed(id, { ok: 8, fail: 6, slow: 5 }, -15); // после метки window_reset
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(1);
  });

  it("плохие проверки ДО /pause не дают DEGRADED сразу после /resume", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    await telegram.handleCommand(CHAT, `/pause ${id}`);
    await telegram.handleCommand(CHAT, `/resume ${id}`);
    fetchMock.mockClear();
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
    expect(lastState(id)).toBeUndefined();
  });

  it("/pause во время цикла: паузнутая прокси не получает DEGRADED", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    vi.mocked(liveness.checkWithFallback).mockImplementation(async () => {
      db.toggleProxy(id, false); // /pause пришёл, пока идёт проверка
      return { ok: true, responseTime: 100, usedFallback: false };
    });
    fetchMock.mockClear();
    await monitor.runChecks();
    expect(degradedMsgs()).toHaveLength(0);
    expect(lastState(id)).toBeUndefined();
  });

  it("/edit во время отправки DEGRADED: состояние для нового устройства не пишется", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    fetchMock.mockImplementation(async () => {
      db.updateProxyEndpoint(id, {
        host: "new-host.example.com", port: 8080, type: "http", username: null, password: null,
      });
      return { ok: true, status: 200, text: async () => "" };
    });
    await monitor.runChecks();
    expect(lastState(id)).toBeUndefined();
  });

  it("/pause + /resume во время отправки DEGRADED: состояние не пишется", async () => {
    const id = freshProxy();
    seed(id, { ok: 8, fail: 6, slow: 5 });
    fetchMock.mockImplementation(async () => {
      db.toggleProxy(id, false);
      db.saveAlert(id, "window_reset"); // как в /pause
      db.toggleProxy(id, true);
      return { ok: true, status: 200, text: async () => "" };
    });
    await monitor.runChecks();
    expect(lastState(id)).toBeUndefined();
  });

  it("/edit во время отправки «Деградация прошла»: degraded_recovery не дублируется", async () => {
    const id = freshProxy();
    alertAt(id, "degraded", 65);
    seed(id, { ok: 18 });
    fetchMock.mockImplementation(async () => {
      db.updateProxyEndpoint(id, {
        host: "new-host.example.com", port: 8080, type: "http", username: null, password: null,
      });
      return { ok: true, status: 200, text: async () => "" };
    });
    await monitor.runChecks();
    expect(recoveryRows(id)).toBe(1); // одна — от /edit
  });

  it("/pause + /resume во время отправки «Деградация прошла»: degraded_recovery не дублируется", async () => {
    const id = freshProxy();
    alertAt(id, "degraded", 65);
    seed(id, { ok: 18 });
    fetchMock.mockImplementation(async () => {
      db.toggleProxy(id, false);
      db.closeDegraded(id); // как в /pause
      db.saveAlert(id, "window_reset");
      db.toggleProxy(id, true);
      return { ok: true, status: 200, text: async () => "" };
    });
    await monitor.runChecks();
    expect(recoveryRows(id)).toBe(1);
  });

  it("неудачная отправка «Деградация прошла» не закрывает деградацию — следующий цикл повторит", async () => {
    const id = freshProxy();
    alertAt(id, "degraded", 65);
    seed(id, { ok: 18 });
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "bad" });
    await monitor.runChecks();
    expect(lastState(id)).toBe("degraded");

    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    await monitor.runChecks();
    expect(lastState(id)).toBe("degraded_recovery");
  });

  it("/pause несуществующего id отвечает, а не падает на FK", async () => {
    await expect(telegram.handleCommand(CHAT, "/pause 999999")).resolves.toBeUndefined();
    expect(sent().join("\n")).toContain("не найдена");
  });

  it("/resume несуществующего id отвечает «не найдена», а не «возобновлён»", async () => {
    await telegram.handleCommand(CHAT, "/resume 999999");
    expect(sent().join("\n")).toContain("не найдена");
    expect(sent().join("\n")).not.toContain("возобновлён");
  });

  it("/qreset состояния деградации не трогает и окно не сдвигает", async () => {
    const open = freshProxy("OPEN");
    alertAt(open, "degraded", 20);
    seed(open, { ok: 8, fail: 6, slow: 5 });
    const fresh = freshProxy("NEW");
    seed(fresh, { ok: 8, fail: 6, slow: 5 });

    await telegram.handleCommand(CHAT, "/qreset");
    expect(lastState(open)).toBe("degraded");
    fetchMock.mockClear();

    await monitor.runChecks();
    expect(degradedMsgs().filter((t) => t.includes("NEW"))).toHaveLength(1);
    expect(degradedMsgs().filter((t) => t.includes("OPEN"))).toHaveLength(0);
    expect(lastState(open)).toBe("degraded");
  });

  it("/del чистит состояние вместе с alerts (CASCADE)", async () => {
    const id = freshProxy();
    alertAt(id, "degraded", 20);
    await telegram.handleCommand(CHAT, `/del ${id}`);
    expect(db.getLastAlert(id, "degraded")).toBeUndefined();
  });

  it("/list помечает прокси в деградации", async () => {
    const id = freshProxy("MARK");
    seed(id, { ok: 3 });
    alertAt(id, "degraded", 5);
    fetchMock.mockClear();
    await telegram.handleCommand(CHAT, "/list");
    expect(sent().join("\n")).toContain("DEGRADED");
  });
});

describe("форматирование", () => {
  it("DEGRADED без label и группы показывает host:port; медиана без успешных — прочерк", () => {
    const msg = telegram.formatDegradedAlert(
      "h.example.com", 8080, "http",
      { total: 10, bad: 10, failed: 10, slow: 0, medianMs: null, p90Ms: null },
      15, 5000
    );
    expect(msg).toContain("h.example.com:8080");
    expect(msg).toContain("10 отказов");
    expect(msg).toContain("медиана —");
  });

  it("склонение отказов", () => {
    const f = (n: number) =>
      telegram.formatDegradedAlert("h.example.com", 1, "http",
        { total: 30, bad: n, failed: n, slow: 0, medianMs: 1, p90Ms: 1 }, 15, 5000);
    expect(f(1)).toContain("1 отказ,");
    expect(f(2)).toContain("2 отказа,");
    expect(f(5)).toContain("5 отказов,");
    expect(f(11)).toContain("11 отказов,");
    expect(f(21)).toContain("21 отказ,");
  });

  it("экранирует HTML в label", () => {
    const msg = telegram.formatDegradedRecoveryAlert("h.example.com", 1, "http", 90_000, "<b>x</b>");
    expect(msg).not.toContain("<b>x</b>");
    expect(msg).toContain("&lt;b&gt;");
    expect(msg).toContain("1 мин");
  });

  it("/list не показывает DEGRADED при выключенной фиче", async () => {
    const id = freshProxy("OFF");
    seed(id, { ok: 3 });
    alertAt(id, "degraded", 5);
    config.DEGRADED_WINDOW_MIN = 0;
    fetchMock.mockClear();
    await telegram.handleCommand(CHAT, "/list");
    expect(sent().join("\n")).not.toContain("DEGRADED");
  });
});
