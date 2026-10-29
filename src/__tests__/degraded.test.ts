import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  summarizeWindow,
  evaluateDegraded,
  type DegradedParams,
  type WindowCheck,
} from "../degraded.js";

const P: DegradedParams = { slowMs: 5000, minChecks: 10, ratio: 0.3, recoverRatio: 0.1 };

const up = (ms: number): WindowCheck => ({ status: "up", response_time: ms });
const down = (ms = 10_000): WindowCheck => ({ status: "down", response_time: ms });
const many = (n: number, c: WindowCheck) => Array.from({ length: n }, () => c);

describe("summarizeWindow", () => {
  it("отказ и медленный успех — плохие, быстрый успех — нет", () => {
    const s = summarizeWindow([up(100), up(6000), down(), up(5000)], 5000);
    expect(s).toMatchObject({ total: 4, bad: 2, failed: 1, slow: 1 });
  });

  it("порог строгий: ровно slowMs — не медленно", () => {
    expect(summarizeWindow([up(5000)], 5000).slow).toBe(0);
    expect(summarizeWindow([up(5001)], 5000).slow).toBe(1);
  });

  it("успех через fallback с суммарным откликом выше порога — плохая проверка", () => {
    // checkWithFallback суммирует время обеих попыток: 10 с таймаута + быстрый запасной
    expect(summarizeWindow([up(10_300)], 5000).bad).toBe(1);
  });

  it("медиана и p90 считаются по успешным проверкам, отказы в них не входят", () => {
    const checks = [...[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map(up), down(30_000)];
    const s = summarizeWindow(checks, 5000);
    expect(s.medianMs).toBe(500); // ближайший ранг: нижняя из двух средних
    expect(s.p90Ms).toBe(900);
  });

  it("без успешных проверок медиана и p90 равны null", () => {
    const s = summarizeWindow(many(3, down()), 5000);
    expect(s.medianMs).toBeNull();
    expect(s.p90Ms).toBeNull();
  });

  it("up с response_time = null не падает и не считается медленным", () => {
    const s = summarizeWindow([{ status: "up", response_time: null }], 5000);
    expect(s).toMatchObject({ total: 1, bad: 0, slow: 0, medianMs: null });
  });
});

describe("evaluateDegraded", () => {
  const stats = (bad: number, total: number) =>
    summarizeWindow([...many(bad, down()), ...many(total - bad, up(100))], P.slowMs);

  it("порог входа включительный: 30% — деградация, 29% — нет", () => {
    expect(evaluateDegraded(stats(6, 20), false, P)).toBe("degrade");
    expect(evaluateDegraded(stats(5, 20), false, P)).toBe("none");
  });

  it("меньше minChecks вердикта нет, даже если все проверки плохие", () => {
    expect(evaluateDegraded(stats(9, 9), false, P)).toBe("none");
    expect(evaluateDegraded(stats(10, 10), false, P)).toBe("degrade");
  });

  it("гистерезис: между порогами состояние не меняется", () => {
    // 4 из 20 = 20%: ниже входа, выше выхода
    expect(evaluateDegraded(stats(4, 20), true, P)).toBe("none");
    expect(evaluateDegraded(stats(4, 20), false, P)).toBe("none");
  });

  it("выход строго ниже recoverRatio: 10% — ещё нет, 5% — да", () => {
    expect(evaluateDegraded(stats(2, 20), true, P)).toBe("none");
    expect(evaluateDegraded(stats(1, 20), true, P)).toBe("recover");
  });

  it("в деградации повторного degrade нет", () => {
    expect(evaluateDegraded(stats(12, 20), true, P)).toBe("none");
  });

  it("при нехватке проверок деградация не закрывается", () => {
    expect(evaluateDegraded(stats(0, 5), true, P)).toBe("none");
  });
});

describe("resolveDegradedRecoverRatio", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.TELEGRAM_BOT_TOKEN = "test";
    process.env.TELEGRAM_CHAT_ID = "12345";
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEGRADED_RATIO;
    delete process.env.DEGRADED_RECOVER_RATIO;
  });

  it("выход выше входа поднимается не выше входа с warn", async () => {
    process.env.DEGRADED_RATIO = "0.2";
    process.env.DEGRADED_RECOVER_RATIO = "0.5";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config } = await import("../config.js");
    expect(config.DEGRADED_RATIO).toBe(0.2);
    expect(config.DEGRADED_RECOVER_RATIO).toBe(0.2);
    expect(warn.mock.calls.some((a) => String(a[0]).includes("DEGRADED_RECOVER_RATIO"))).toBe(true);
  });

  it("дефолты из бэктеста", async () => {
    const { config } = await import("../config.js");
    expect(config).toMatchObject({
      DEGRADED_WINDOW_MIN: 20,
      DEGRADED_SLOW_MS: 5000,
      DEGRADED_MIN_CHECKS: 14,
      DEGRADED_RATIO: 0.25,
      DEGRADED_RECOVER_RATIO: 0.1,
    });
  });

  it("мусор в env — дефолт", async () => {
    process.env.DEGRADED_RATIO = "abc";
    const { config } = await import("../config.js");
    expect(config.DEGRADED_RATIO).toBe(0.25);
  });
});
