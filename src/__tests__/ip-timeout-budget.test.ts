import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    ALLOW_PRIVATE_TARGETS: true,
    IP_ECHO_URLS: ["http://first.test/", "http://second.test/"],
  },
}));

vi.mock("../checker/transport.js", () => ({ httpViaProxy: vi.fn() }));

import { fetchExternalIp } from "../checker/ip.js";
import { httpViaProxy } from "../checker/transport.js";
import type { ProxyRow } from "../db.js";

const proxy: ProxyRow = {
  id: 1,
  host: "127.0.0.1",
  port: 1080,
  type: "socks5",
  username: null,
  password: null,
  label: null,
  group_name: null,
  enabled: 1,
  created_at: "2026-01-01 00:00:00",
};

const mocked = vi.mocked(httpViaProxy);

beforeEach(() => {
  mocked.mockReset();
});

describe("бюджет времени IP-пробы", () => {
  /**
   * Мобильные прокси отвечают на холодную ~8.7 с — при делении общего бюджета
   * между адресами попытке доставалось 5 с, и проба таймаутила там, где
   * liveness со своими 10 с проходила.
   */
  it("даёт попытке столько же времени, сколько liveness — независимо от числа адресов", async () => {
    mocked.mockResolvedValue({ status: 200, body: "203.0.113.7", elapsedMs: 8_700 });

    await fetchExternalIp(proxy);

    expect(mocked.mock.calls[0][2].timeoutMs).toBe(10_000);
  });

  it("не берётся за следующий адрес, когда общий бюджет исчерпан", async () => {
    mocked.mockImplementation(async () => {
      vi.advanceTimersByTime(20_000);
      return { error: "Timeout", elapsedMs: 20_000 };
    });

    vi.useFakeTimers();
    try {
      const result = await fetchExternalIp(proxy);
      expect(mocked).toHaveBeenCalledTimes(1);
      expect(result.error).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("перебирает адреса, пока бюджет позволяет", async () => {
    mocked
      .mockResolvedValueOnce({ error: "Timeout", elapsedMs: 10_000 })
      .mockResolvedValueOnce({ status: 200, body: "203.0.113.7", elapsedMs: 800 });

    const result = await fetchExternalIp(proxy);

    expect(mocked).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ip: "203.0.113.7" });
  });
});
