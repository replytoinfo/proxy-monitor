import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    ALLOW_PRIVATE_TARGETS: true,
  },
}));

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { measureSpeed } from "../checker/speed.js";
import { startFakeSocks5 } from "./helpers/socks-server.js";
import type { ProxyRow } from "../db.js";

function makeProxy(
  port: number,
  type: "http" | "socks5",
  creds?: { username: string; password: string }
): ProxyRow {
  return {
    id: 1,
    host: "127.0.0.1",
    port,
    type,
    username: creds?.username ?? null,
    password: creds?.password ?? null,
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

const URL_1MB = new URL("http://target.example/__down?bytes=65536");

describe("measureSpeed via http proxy", () => {
  it("counts body bytes and reports complete on full download", async () => {
    const body = Buffer.alloc(65536, "x");
    const srv = await startProxyServer((req, res) => {
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.end(body);
    });

    const result = await measureSpeed(makeProxy(srv.port, "http"), URL_1MB, 5000);
    await srv.close();

    expect(result.error).toBeUndefined();
    expect(result.bytes).toBe(65536);
    expect(result.complete).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("sends Proxy-Authorization when proxy has credentials", async () => {
    let seenAuth: string | undefined;
    const srv = await startProxyServer((req, res) => {
      seenAuth = req.headers["proxy-authorization"];
      res.writeHead(200, { "Content-Length": "3" });
      res.end("abc");
    });

    await measureSpeed(
      makeProxy(srv.port, "http", { username: "user", password: "pass" }),
      URL_1MB,
      5000
    );
    await srv.close();

    const expected = `Basic ${Buffer.from("user:pass").toString("base64")}`;
    expect(seenAuth).toBe(expected);
  });

  it("rejects non-2xx status without counting bytes", async () => {
    const srv = await startProxyServer((req, res) => {
      res.writeHead(502, { "Content-Length": "9" });
      res.end("Bad thing");
    });

    const result = await measureSpeed(makeProxy(srv.port, "http"), URL_1MB, 5000);
    await srv.close();

    expect(result.error).toBe("HTTP 502");
    expect(result.bytes).toBe(0);
    expect(result.complete).toBe(false);
  });

  it("fails when response has no Content-Length", async () => {
    const srv = await startProxyServer((req, res) => {
      // chunked: писать без заголовка Content-Length
      res.writeHead(200);
      res.write("part");
      res.end();
    });

    const result = await measureSpeed(makeProxy(srv.port, "http"), URL_1MB, 5000);
    await srv.close();

    expect(result.error).toBe("No Content-Length");
    expect(result.complete).toBe(false);
  });

  it("returns partial result when deadline hits a slow but active stream", async () => {
    // Сервер шлёт байты постоянно, никогда не простаивает — idle-таймаут
    // его бы не остановил. Остановить обязан общий дедлайн.
    const timers: NodeJS.Timeout[] = [];
    const srv = await startProxyServer((req, res) => {
      res.writeHead(200, { "Content-Length": String(1024 * 1024) });
      const t = setInterval(() => res.write(Buffer.alloc(1024, "x")), 20);
      timers.push(t);
      res.on("close", () => clearInterval(t));
    });

    const started = Date.now();
    const result = await measureSpeed(makeProxy(srv.port, "http"), URL_1MB, 400);
    const elapsed = Date.now() - started;
    timers.forEach(clearInterval);
    await srv.close();

    expect(result.error).toBeUndefined();
    expect(result.complete).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.bytes).toBeLessThan(1024 * 1024);
    expect(elapsed).toBeLessThan(2000);
  });

  it("reports Timeout when no body bytes arrive before the deadline", async () => {
    const srv = await startProxyServer((req, res) => {
      res.writeHead(200, { "Content-Length": String(1024) });
      // тело не отправляется вовсе
    });

    const result = await measureSpeed(makeProxy(srv.port, "http"), URL_1MB, 300);
    await srv.close();

    expect(result.error).toBe("Timeout");
    expect(result.bytes).toBe(0);
  });
});

describe("measureSpeed via socks5 proxy", () => {
  it("counts body bytes through the tunnel", async () => {
    const body = "y".repeat(4096);
    const srv = await startFakeSocks5({
      response: `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    });

    const result = await measureSpeed(makeProxy(srv.port, "socks5"), URL_1MB, 5000);
    await srv.close();

    expect(result.error).toBeUndefined();
    expect(result.bytes).toBe(4096);
    expect(result.complete).toBe(true);
  });

  it("passes credentials through socks auth", async () => {
    const srv = await startFakeSocks5({
      requireAuth: true,
      credentials: { username: "u1", password: "p1" },
      response: "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    });

    const result = await measureSpeed(
      makeProxy(srv.port, "socks5", { username: "u1", password: "p1" }),
      URL_1MB,
      5000
    );
    await srv.close();

    expect(result.error).toBeUndefined();
    expect(result.bytes).toBe(2);
  });

  it("rejects non-2xx status from the tunnel", async () => {
    const srv = await startFakeSocks5({
      response: "HTTP/1.1 407 Proxy Auth Required\r\nContent-Length: 4\r\n\r\nnope",
    });

    const result = await measureSpeed(makeProxy(srv.port, "socks5"), URL_1MB, 5000);
    await srv.close();

    expect(result.error).toBe("HTTP 407");
    expect(result.bytes).toBe(0);
  });

  it("returns partial result when the tunnel closes before Content-Length", async () => {
    // Заявлено 8192, отдано 2048 — например, прокси сменила IP посреди скачивания.
    const srv = await startFakeSocks5({
      response: `HTTP/1.1 200 OK\r\nContent-Length: 8192\r\n\r\n${"z".repeat(2048)}`,
    });

    const result = await measureSpeed(makeProxy(srv.port, "socks5"), URL_1MB, 5000);
    await srv.close();

    expect(result.error).toBeUndefined();
    expect(result.complete).toBe(false);
    expect(result.bytes).toBe(2048);
  });
});
