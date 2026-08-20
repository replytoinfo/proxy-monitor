import { describe, it, expect, vi } from "vitest";
import { checkWithFallback } from "../checker/liveness.js";
import { createSemaphore, runAllSettled } from "../pool.js";

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
import type { AddressInfo } from "node:net";
import { checkLiveness } from "../checker/liveness.js";
import { startFakeSocks5 } from "./helpers/socks-server.js";
import type { ProxyRow } from "../db.js";

const CHECK_URL = new URL("http://httpbin.org/status/200");

function makeProxy(port: number, type: "http" | "socks5", auth = false): ProxyRow {
  return {
    id: 1,
    host: "127.0.0.1",
    port,
    type,
    username: auth ? "user" : null,
    password: auth ? "pass" : null,
    label: null,
    group_name: null,
    enabled: 1,
    created_at: "2026-01-01 00:00:00",
  };
}

async function startProxyServer(
  handler: http.RequestListener
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("checkLiveness over an HTTP proxy", () => {
  it("is up on 2xx", async () => {
    const server = await startProxyServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });

    try {
      const result = await checkLiveness(makeProxy(server.port, "http"), CHECK_URL, 2000);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("is up on 3xx", async () => {
    const server = await startProxyServer((_req, res) => {
      res.writeHead(301, { Location: "http://example.test/" });
      res.end();
    });

    try {
      const result = await checkLiveness(makeProxy(server.port, "http"), CHECK_URL, 2000);
      expect(result.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("is down on 5xx and reports the status", async () => {
    const server = await startProxyServer((_req, res) => {
      res.writeHead(502);
      res.end();
    });

    try {
      const result = await checkLiveness(makeProxy(server.port, "http"), CHECK_URL, 2000);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("HTTP 502");
    } finally {
      await server.close();
    }
  });
});

describe("checkLiveness over a SOCKS5 proxy", () => {
  it("is down when the proxy accepts auth but refuses the connection", async () => {
    // Регрессия: до перехода на реальный транспорт такая прокси считалась up —
    // проверка заканчивалась на успешной авторизации и наружу не ходила.
    const socks = await startFakeSocks5({
      requireAuth: true,
      credentials: { username: "user", password: "pass" },
      connectReply: 0x05,
    });

    try {
      const result = await checkLiveness(
        makeProxy(socks.port, "socks5", true),
        CHECK_URL,
        2000
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Socks5 proxy rejected connection");
    } finally {
      await socks.close();
    }
  });

  it("tells an auth failure apart from a refused connection", async () => {
    const socks = await startFakeSocks5({
      requireAuth: true,
      credentials: { username: "user", password: "correct-pass" },
    });

    try {
      const result = await checkLiveness(
        makeProxy(socks.port, "socks5", true),
        CHECK_URL,
        2000
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Socks5 Authentication failed");
    } finally {
      await socks.close();
    }
  });

  it("is up when auth passes and the tunnel answers 2xx", async () => {
    const socks = await startFakeSocks5({
      requireAuth: true,
      credentials: { username: "user", password: "pass" },
      response: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
    });

    try {
      const result = await checkLiveness(
        makeProxy(socks.port, "socks5", true),
        CHECK_URL,
        2000
      );
      expect(result.ok).toBe(true);
      expect(socks.lastRequest()).toContain("HEAD /status/200 HTTP/1.1\r\n");
    } finally {
      await socks.close();
    }
  });

  it("is down when the tunnel answers 5xx", async () => {
    const socks = await startFakeSocks5({
      response: "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
    });

    try {
      const result = await checkLiveness(makeProxy(socks.port, "socks5"), CHECK_URL, 2000);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("HTTP 503");
    } finally {
      await socks.close();
    }
  });
});

const FALLBACK_URL = new URL("http://www.gstatic.com/generate_204");

describe("checkWithFallback", () => {
  it("is up without touching the fallback when the primary answers", async () => {
    let hits = 0;
    const server = await startProxyServer((_req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end();
    });

    try {
      const result = await checkWithFallback(
        makeProxy(server.port, "http"),
        CHECK_URL,
        FALLBACK_URL
      );
      expect(result.ok).toBe(true);
      expect(result.usedFallback).toBe(false);
      expect(hits).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("is up when the primary fails and the fallback answers", async () => {
    const server = await startProxyServer((req, res) => {
      if (req.url?.includes("httpbin.org")) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
    });

    try {
      const result = await checkWithFallback(
        makeProxy(server.port, "http"),
        CHECK_URL,
        FALLBACK_URL
      );
      expect(result.ok).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(result.error).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("is down with both reasons when both fail", async () => {
    const server = await startProxyServer((req, res) => {
      res.writeHead(req.url?.includes("httpbin.org") ? 503 : 500);
      res.end();
    });

    try {
      const result = await checkWithFallback(
        makeProxy(server.port, "http"),
        CHECK_URL,
        FALLBACK_URL
      );
      expect(result.ok).toBe(false);
      expect(result.usedFallback).toBe(true);
      expect(result.error).toBe("основной: HTTP 503; запасной: HTTP 500");
      expect(result.error!.length).toBeLessThanOrEqual(200);
      // responseTime суммируется из двух вызовов; при sub-ms сервере оба
      // могут быть 0ms — timing assertion убрана как зависимость от реального времени.
    } finally {
      await server.close();
    }
  });

  it("does not retry when there is no fallback configured", async () => {
    let hits = 0;
    const server = await startProxyServer((_req, res) => {
      hits += 1;
      res.writeHead(503);
      res.end();
    });

    try {
      const result = await checkWithFallback(makeProxy(server.port, "http"), CHECK_URL, null);
      expect(result.ok).toBe(false);
      expect(result.usedFallback).toBe(false);
      expect(result.error).toBe("HTTP 503");
      expect(hits).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("completes under a pool of one slot when the fallback is used", async () => {
    // Регрессия на взаимную блокировку: слот берётся снаружи, а запасная
    // попытка идёт внутри той же задачи. Вложенный захват здесь повесил бы тест.
    // Хендлер возвращает 503 на primary и 204 на fallback — гарантируем,
    // что fallback-ветка выполняется, а не пропускается из-за ok=true.
    const server = await startProxyServer((req, res) => {
      if (req.url?.includes("httpbin.org")) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
    });

    try {
      const sem = createSemaphore(1);
      const results = await runAllSettled(sem, [
        () => checkWithFallback(makeProxy(server.port, "http"), CHECK_URL, FALLBACK_URL),
      ]);

      expect(results[0].status).toBe("fulfilled");
      const value = (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof checkWithFallback>>>).value;
      expect(value.usedFallback).toBe(true);
      expect(sem.active()).toBe(0);
    } finally {
      await server.close();
    }
  });
});
