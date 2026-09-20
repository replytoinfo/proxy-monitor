/**
 * F4: IP_CHECK_INTERVAL нормализуется до кратного CHECK_INTERVAL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("resolveIpCheckInterval", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.TELEGRAM_BOT_TOKEN = "test";
    process.env.TELEGRAM_CHAT_ID = "12345";
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });

  afterEach(() => vi.restoreAllMocks());

  it("дефолт 300000 при CHECK_INTERVAL=45000 → 315000 с warn", async () => {
    // k = max(1, ceil(300000/45000)) = ceil(6.67) = 7; 7*45000 = 315000
    process.env.CHECK_INTERVAL = "45000";
    delete process.env.IP_CHECK_INTERVAL;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config } = await import("../config.js");
    expect(config.IP_CHECK_INTERVAL).toBe(315000);
    expect(
      warnSpy.mock.calls.filter((a) => String(a[0]).includes("rounded")).length
    ).toBe(1);
  });

  it("кратное значение не меняется и не вызывает warn", async () => {
    process.env.CHECK_INTERVAL = "60000";
    process.env.IP_CHECK_INTERVAL = "300000"; // 5 × 60000 — кратное
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config } = await import("../config.js");
    expect(config.IP_CHECK_INTERVAL).toBe(300000);
    // warn может быть от ROTATION_MAX_AGE, но не от IP_CHECK_INTERVAL
    const ipWarn = warnSpy.mock.calls.some(
      (args) => args[0]?.toString().includes("IP_CHECK_INTERVAL") && args[0]?.toString().includes("rounded")
    );
    expect(ipWarn).toBe(false);
  });
});
