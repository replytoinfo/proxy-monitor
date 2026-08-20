import { describe, it, expect, vi, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { pingWatchdog } from "../watchdog.js";

const SECRET = "s3cr3t-ping-id";

async function startServer(
  handler: http.RequestListener
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${SECRET}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pingWatchdog", () => {
  it("hits the url and reports success on 2xx", async () => {
    let hits = 0;
    const server = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end("OK");
    });

    try {
      expect(await pingWatchdog(server.url)).toBe(true);
      expect(hits).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("treats 3xx as success and does not follow the redirect", async () => {
    let hits = 0;
    const server = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(302, { Location: "http://127.0.0.1:1/nowhere" });
      res.end();
    });

    try {
      expect(await pingWatchdog(server.url)).toBe(true);
      expect(hits).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("logs a 500 without leaking the secret url", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = await startServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });

    try {
      expect(await pingWatchdog(server.url)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("HTTP 500");
      expect(logged).not.toContain(SECRET);
    } finally {
      await server.close();
    }
  });

  it("logs a timeout without leaking the secret url", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = await startServer(() => {
      // Молчим — пинг должен упереться в собственный таймаут.
    });

    try {
      expect(await pingWatchdog(server.url, 150)).toBe(false);
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("timeout");
      expect(logged).not.toContain(SECRET);
    } finally {
      await server.close();
    }
  });

  it("logs a network error without leaking the secret url", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = await startServer((_req, res) => res.end());
    const url = server.url;
    await server.close();

    expect(await pingWatchdog(url)).toBe(false);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain(SECRET);
  });
});
