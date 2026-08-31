import * as http from "node:http";
import { SocksClient } from "socks";
import type { ProxyRow } from "../db.js";
import { validateHost } from "../net-policy.js";
import { MAX_ERROR_LEN, sanitizeError } from "./errors.js";

export interface SpeedResult {
  /** Принятые байты тела. При error — 0. */
  bytes: number;
  /** От первого байта тела до конца скачивания или обрыва. */
  ms: number;
  /** Получен весь Content-Length. false + bytes>0 — частичный замер. */
  complete: boolean;
  error?: string;
}

/** Общий дедлайн на передачу; рукопожатие SOCKS имеет свой таймаут ниже. */
export const SPEED_DEADLINE_MS = 30_000;
const HANDSHAKE_TIMEOUT = 10_000;
const MAX_HEADER_BYTES = 8192;

function fail(error: string): SpeedResult {
  return { bytes: 0, ms: 0, complete: false, error: error.slice(0, MAX_ERROR_LEN) };
}

/**
 * Замер скорости: GET через прокси, байты считаются без накопления тела.
 * Требуется 2xx и Content-Length. Дедлайн — абсолютный, не idle: медленный,
 * но не молчащий поток обязан быть остановлен. Обрыв или дедлайн с уже
 * принятыми байтами — частичный результат, не ошибка: медленная прокси
 * и есть целевой сценарий команды.
 */
export async function measureSpeed(
  proxy: ProxyRow,
  url: URL,
  deadlineMs = SPEED_DEADLINE_MS
): Promise<SpeedResult> {
  const blocked = await validateHost(proxy.host);
  if (blocked) return fail(blocked);

  try {
    return proxy.type === "socks5"
      ? await viaSocks(proxy, url, deadlineMs)
      : await viaHttp(proxy, url, deadlineMs);
  } catch (err) {
    return fail(sanitizeError(err));
  }
}

interface Meter {
  bytes: number;
  firstByteAt: number;
}

/** Частичный результат, если байты уже шли; иначе ошибка с данным текстом. */
function cutoff(meter: Meter, noDataError: string): SpeedResult {
  if (meter.bytes === 0) return fail(noDataError);
  return { bytes: meter.bytes, ms: Date.now() - meter.firstByteAt, complete: false };
}

function completed(meter: Meter, expected: number): SpeedResult {
  return {
    bytes: Math.min(meter.bytes, expected),
    ms: Date.now() - meter.firstByteAt,
    complete: true,
  };
}

function countChunk(meter: Meter, length: number): void {
  if (meter.bytes === 0) meter.firstByteAt = Date.now();
  meter.bytes += length;
}

function viaHttp(proxy: ProxyRow, url: URL, deadlineMs: number): Promise<SpeedResult> {
  return new Promise((resolve) => {
    const meter: Meter = { bytes: 0, firstByteAt: 0 };
    let settled = false;

    const done = (result: SpeedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    const reqOptions: http.RequestOptions = {
      hostname: proxy.host,
      port: proxy.port,
      method: "GET",
      path: url.href,
      headers: { Host: url.host },
    };
    if (proxy.username && proxy.password) {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
      reqOptions.headers = { ...reqOptions.headers, "Proxy-Authorization": `Basic ${auth}` };
    }

    const req = http.request(reqOptions, (res) => {
      const status = res.statusCode ?? 0;
      if (!(status >= 200 && status < 300)) {
        res.destroy();
        done(fail(`HTTP ${status || "?"}`));
        return;
      }

      const expected = parseInt(res.headers["content-length"] ?? "", 10);
      if (!Number.isFinite(expected) || expected <= 0) {
        res.destroy();
        done(fail("No Content-Length"));
        return;
      }

      res.on("data", (chunk: Buffer) => {
        countChunk(meter, chunk.length);
        if (meter.bytes >= expected) {
          done(completed(meter, expected));
          res.destroy();
        }
      });
      res.on("end", () => done(cutoff(meter, "Empty response")));
    });

    const deadline = setTimeout(() => {
      done(cutoff(meter, "Timeout"));
      req.destroy();
    }, deadlineMs);

    req.on("error", (err) => done(meter.bytes > 0 ? cutoff(meter, "") : fail(sanitizeError(err))));
    req.end();
  });
}

async function viaSocks(proxy: ProxyRow, url: URL, deadlineMs: number): Promise<SpeedResult> {
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: 5,
      userId: proxy.username ?? undefined,
      password: proxy.password ?? undefined,
    },
    command: "connect",
    destination: { host: url.hostname, port: Number(url.port) || 80 },
    timeout: HANDSHAKE_TIMEOUT,
  });

  return new Promise<SpeedResult>((resolve) => {
    const meter: Meter = { bytes: 0, firstByteAt: 0 };
    let settled = false;
    // latin1: один символ = один байт, арифметика по длине строки честная.
    let headerBuf = "";
    let inBody = false;
    let expected = 0;

    const done = (result: SpeedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(result);
    };

    const deadline = setTimeout(() => done(cutoff(meter, "Timeout")), deadlineMs);

    const checkComplete = () => {
      if (meter.bytes >= expected) done(completed(meter, expected));
    };

    socket.on("data", (chunk: Buffer) => {
      if (inBody) {
        countChunk(meter, chunk.length);
        checkComplete();
        return;
      }

      headerBuf += chunk.toString("latin1");
      const sep = headerBuf.indexOf("\r\n\r\n");
      if (sep === -1) {
        if (headerBuf.length > MAX_HEADER_BYTES) done(fail("Headers too large"));
        return;
      }

      const headers = headerBuf.slice(0, sep);
      const status = Number(headers.slice(0, headers.indexOf("\r\n")).split(" ")[1]);
      if (!(status >= 200 && status < 300)) {
        done(fail(`HTTP ${Number.isFinite(status) && status !== 0 ? status : "?"}`));
        return;
      }

      const clMatch = headers.match(/^content-length:\s*(\d+)/im);
      expected = clMatch ? parseInt(clMatch[1], 10) : 0;
      if (expected <= 0) {
        done(fail("No Content-Length"));
        return;
      }

      inBody = true;
      const bodyBytes = headerBuf.length - (sep + 4);
      headerBuf = "";
      if (bodyBytes > 0) {
        countChunk(meter, bodyBytes);
        checkComplete();
      }
    });

    socket.on("end", () => done(cutoff(meter, "Empty response")));
    socket.on("error", (err) =>
      done(meter.bytes > 0 ? cutoff(meter, "") : fail(sanitizeError(err)))
    );

    socket.write(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        `Connection: close\r\n\r\n`
    );
  });
}
