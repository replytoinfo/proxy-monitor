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
import {
  httpViaProxy,
  parseRawSocksResponse,
  parseFinalRawResponse,
} from "../checker/transport.js";
import { startFakeSocks5 } from "./helpers/socks-server.js";
import type { ProxyRow } from "../db.js";

function makeProxy(port: number, type: "http" | "socks5"): ProxyRow {
  return {
    id: 1,
    host: "127.0.0.1",
    port,
    type,
    username: null,
    password: null,
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

async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("parseRawSocksResponse", () => {
  it("returns null when headers have not arrived yet", () => {
    expect(parseRawSocksResponse("HTTP/1.1 200 OK\r\nContent-Length: 11")).toBeNull();
  });

  it("returns the body for a Content-Length response", () => {
    const raw = "HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n203.0.113.7";
    expect(parseRawSocksResponse(raw)).toEqual({ status: 200, body: "203.0.113.7" });
  });

  it("returns null when the Content-Length body is not complete", () => {
    const raw = "HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n203.0.1";
    expect(parseRawSocksResponse(raw)).toBeNull();
  });

  it("returns the first chunk of a chunked response", () => {
    const raw =
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n203.0.113.7\r\n0\r\n\r\n";
    expect(parseRawSocksResponse(raw)).toEqual({ status: 200, body: "203.0.113.7" });
  });

  it("returns null when the chunk data is not complete", () => {
    const raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n203.0.1";
    expect(parseRawSocksResponse(raw)).toBeNull();
  });

  it("returns the status without a body for a non-2xx answer", () => {
    const raw = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
    expect(parseRawSocksResponse(raw)).toEqual({ status: 403, body: "" });
  });

  it("parses a body behind headers larger than the raw limit", () => {
    const bigHeader = "X-Custom: " + "a".repeat(1100);
    const raw = `HTTP/1.1 200 OK\r\n${bigHeader}\r\nContent-Length: 11\r\n\r\n203.0.113.7`;
    expect(parseRawSocksResponse(raw)).toEqual({ status: 200, body: "203.0.113.7" });
  });

  it("matches headers case-insensitively", () => {
    const raw = "HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n203.0.113.7";
    expect(parseRawSocksResponse(raw)).toEqual({ status: 200, body: "203.0.113.7" });
    const chunked =
      "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nb\r\n203.0.113.7\r\n0\r\n\r\n";
    expect(parseRawSocksResponse(chunked)).toEqual({ status: 200, body: "203.0.113.7" });
  });

  it("waits for the end event when there is neither Content-Length nor chunked", () => {
    const raw = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n203.0.113.7";
    expect(parseRawSocksResponse(raw)).toBeNull();
  });

  it("does not wait for a body when the caller does not want one", () => {
    // Ответ на HEAD несёт Content-Length, но тела за ним не будет —
    // ожидание тела повесило бы проверку до таймаута.
    const raw = "HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n";
    expect(parseRawSocksResponse(raw, false)).toEqual({ status: 200, body: "" });
  });
});

describe("parseFinalRawResponse", () => {
  it("returns everything after the header separator", () => {
    const raw = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n203.0.113.7";
    expect(parseFinalRawResponse(raw)).toEqual({ status: 200, body: "203.0.113.7" });
  });

  it("returns null without a header separator", () => {
    expect(parseFinalRawResponse("HTTP/1.1 200 OK\r\n")).toBeNull();
  });
});

describe("httpViaProxy over an HTTP proxy", () => {
  it("returns status and body for GET", async () => {
    let capturedUrl = "";
    const server = await startProxyServer((req, res) => {
      capturedUrl = req.url ?? "";
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("203.0.113.7");
    });

    try {
      const result = await httpViaProxy(
        makeProxy(server.port, "http"),
        new URL("http://api.ipify.org/"),
        { method: "GET", maxBodyBytes: 64, timeoutMs: 2000 }
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe("203.0.113.7");
      expect(capturedUrl).toBe("http://api.ipify.org/");
    } finally {
      await server.close();
    }
  });

  it("does not read a body for HEAD", async () => {
    let capturedMethod = "";
    const server = await startProxyServer((req, res) => {
      capturedMethod = req.method ?? "";
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("this body must not be read");
    });

    try {
      const result = await httpViaProxy(
        makeProxy(server.port, "http"),
        new URL("http://httpbin.org/status/200"),
        { method: "HEAD", maxBodyBytes: 0, timeoutMs: 2000 }
      );
      expect(capturedMethod).toBe("HEAD");
      expect(result.status).toBe(200);
      expect(result.body).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("sends a Host header that keeps a non-default port", async () => {
    let capturedHost = "";
    const server = await startProxyServer((req, res) => {
      capturedHost = req.headers.host ?? "";
      res.writeHead(204);
      res.end();
    });

    try {
      await httpViaProxy(
        makeProxy(server.port, "http"),
        new URL("http://example.test:8081/ping"),
        { method: "HEAD", maxBodyBytes: 0, timeoutMs: 2000 }
      );
      expect(capturedHost).toBe("example.test:8081");
    } finally {
      await server.close();
    }
  });

  it("returns an error instead of throwing on timeout", async () => {
    const server = await startProxyServer(() => {
      // Молчим — клиент должен упереться в собственный таймаут.
    });

    try {
      const result = await httpViaProxy(
        makeProxy(server.port, "http"),
        new URL("http://api.ipify.org/"),
        { method: "HEAD", maxBodyBytes: 0, timeoutMs: 150 }
      );
      expect(result.error).toBe("Timeout");
      expect(result.status).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("returns an error instead of throwing on a refused connection", async () => {
    const port = await closedPort();
    const result = await httpViaProxy(
      makeProxy(port, "http"),
      new URL("http://api.ipify.org/"),
      { method: "HEAD", maxBodyBytes: 0, timeoutMs: 2000 }
    );
    expect(result.error).toBe("Connection refused");
  });
});

describe("httpViaProxy over a SOCKS5 proxy", () => {
  it("returns the same result as the HTTP transport for the same answer", async () => {
    const socks = await startFakeSocks5({
      response: "HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n203.0.113.7",
    });

    try {
      const result = await httpViaProxy(
        makeProxy(socks.port, "socks5"),
        new URL("http://api.ipify.org/"),
        { method: "GET", maxBodyBytes: 64, timeoutMs: 2000 }
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe("203.0.113.7");
      expect(socks.lastRequest()).toContain("GET / HTTP/1.1\r\n");
      expect(socks.lastRequest()).toContain("Host: api.ipify.org\r\n");
    } finally {
      await socks.close();
    }
  });

  it("does not wait for a body on HEAD even when Content-Length is present", async () => {
    const socks = await startFakeSocks5({
      response: "HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n",
    });

    try {
      const result = await httpViaProxy(
        makeProxy(socks.port, "socks5"),
        new URL("http://httpbin.org/status/200"),
        { method: "HEAD", maxBodyBytes: 0, timeoutMs: 2000 }
      );
      expect(result.status).toBe(200);
      expect(result.body).toBeUndefined();
    } finally {
      await socks.close();
    }
  });

  it("reports a rejected connection as an error, not a throw", async () => {
    const socks = await startFakeSocks5({ connectReply: 0x05 });

    try {
      const result = await httpViaProxy(
        makeProxy(socks.port, "socks5"),
        new URL("http://api.ipify.org/"),
        { method: "GET", maxBodyBytes: 64, timeoutMs: 2000 }
      );
      expect(result.status).toBeUndefined();
      expect(result.error).toContain("Socks5 proxy rejected connection");
    } finally {
      await socks.close();
    }
  });

  it("keeps a Host header with a non-default port", async () => {
    const socks = await startFakeSocks5({
      response: "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n",
    });

    try {
      await httpViaProxy(
        makeProxy(socks.port, "socks5"),
        new URL("http://example.test:8081/ping"),
        { method: "HEAD", maxBodyBytes: 0, timeoutMs: 2000 }
      );
      expect(socks.lastRequest()).toContain("Host: example.test:8081\r\n");
    } finally {
      await socks.close();
    }
  });
});
