import { describe, it, expect, vi } from "vitest";

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
    IP_CHECK_INTERVAL: 300000,
    ROTATION_MAX_AGE: 2700000,
    IP_ECHO_URLS: ["http://api.ipify.org/"],
    CHECK_URL: "http://httpbin.org/status/200",
    CHECK_URL_FALLBACK: "http://www.gstatic.com/generate_204",
    IP_PROBE_FAIL_THRESHOLD: 3,
    HEALTHCHECK_URL: null,
  },
}));

import * as http from "node:http";
import { fetchExternalIp, parseIpBody } from "../checker/ip.js";
import type { ProxyRow } from "../db.js";

describe("parseIpBody", () => {
  it("accepts IPv4", () => {
    expect(parseIpBody("203.0.113.7\n")).toEqual({ ip: "203.0.113.7" });
  });

  it("accepts IPv6", () => {
    expect(parseIpBody("2001:db8::1")).toEqual({ ip: "2001:db8::1" });
  });

  it("rejects garbage", () => {
    expect(parseIpBody("<html>nope</html>").error).toBeDefined();
  });

  it("rejects a body longer than the limit", () => {
    expect(parseIpBody("1.2.3.4" + "0".repeat(200)).error).toBeDefined();
  });
});

function makeProxy(port: number): ProxyRow {
  return {
    id: 1,
    host: "127.0.0.1",
    port,
    type: "http",
    username: null,
    password: null,
    label: null,
    group_name: null,
    enabled: 1,
    created_at: "2026-01-01 00:00:00",
  };
}

describe("fetchExternalIp over an HTTP proxy", () => {
  it("returns the IP the echo service reports", async () => {
    let capturedUrl: string | undefined;

    const server = http.createServer((req, res) => {
      // Прокси получает absolute-URI в строке запроса — сохраняем для проверки вне обработчика
      capturedUrl = req.url ?? undefined;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("203.0.113.7");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const result = await fetchExternalIp(makeProxy(port));
      expect(result).toEqual({ ip: "203.0.113.7" });
      expect(capturedUrl).toBe("http://api.ipify.org/");
    } finally {
      server.close();
    }
  });

  it("reports a non-2xx answer as an error", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(502);
      res.end("bad gateway");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const result = await fetchExternalIp(makeProxy(port));
      // Новый формат: "<hostname>: HTTP <code>" — перебор нескольких сервисов.
      expect(result.error).toMatch(/HTTP 502/);
    } finally {
      server.close();
    }
  });
});
