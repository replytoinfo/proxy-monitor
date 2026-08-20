import * as http from "node:http";
import { SocksClient } from "socks";
import type { ProxyRow } from "../db.js";
import { sanitizeError } from "./errors.js";

export interface TransportOptions {
  method: "GET" | "HEAD";
  /** Сколько байт тела читать. Для HEAD не используется. */
  maxBodyBytes: number;
  timeoutMs: number;
}

export interface TransportResult {
  status?: number;
  body?: string;
  error?: string;
  elapsedMs: number;
}

export interface RawResponse {
  status: number;
  body: string;
}

/** Потолок сырого ответа в SOCKS5-потоке: заголовки вместе с телом. */
const RAW_LIMIT = 1024;

function parseStatus(raw: string): number {
  return Number(raw.slice(0, raw.indexOf("\r\n")).split(" ")[1]);
}

/**
 * Инкрементальный разборщик сырого HTTP-ответа в SOCKS5-потоке.
 * null — данных ещё недостаточно, ждём следующий чанк.
 *
 * wantBody=false (HEAD): достаточно заголовков. Ответ на HEAD несёт
 * Content-Length, но тела за ним не будет — ожидание тела повесило бы
 * проверку до таймаута.
 */
export function parseRawSocksResponse(raw: string, wantBody = true): RawResponse | null {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep === -1) return null;

  const status = parseStatus(raw);
  if (!Number.isFinite(status) || status === 0) return { status: 0, body: "" };
  if (!wantBody) return { status, body: "" };
  if (!(status >= 200 && status < 300)) return { status, body: "" };

  const headers = raw.slice(0, sep);
  const body = raw.slice(sep + 4);

  const clMatch = headers.match(/^content-length:\s*(\d+)/im);
  if (clMatch) {
    const len = parseInt(clMatch[1], 10);
    if (body.length < len) return null;
    return { status, body: body.slice(0, len) };
  }

  const teMatch = headers.match(/^transfer-encoding:\s*chunked/im);
  if (teMatch) {
    const crlfIdx = body.indexOf("\r\n");
    if (crlfIdx === -1) return null;
    const chunkSize = parseInt(body.slice(0, crlfIdx), 16);
    if (isNaN(chunkSize) || chunkSize <= 0) return { status, body: "" };
    if (body.length < crlfIdx + 2 + chunkSize) return null;
    return { status, body: body.slice(crlfIdx + 2, crlfIdx + 2 + chunkSize) };
  }

  return null;
}

/** Разбор при закрытии соединения: телом считается всё, что после заголовков. */
export function parseFinalRawResponse(raw: string): RawResponse | null {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep === -1) return null;

  const status = parseStatus(raw);
  if (!Number.isFinite(status) || status === 0) return { status: 0, body: "" };
  return { status, body: raw.slice(sep + 4) };
}

function viaHttp(
  proxy: ProxyRow,
  url: URL,
  options: TransportOptions,
  start: number
): Promise<TransportResult> {
  return new Promise((resolve) => {
    const reqOptions: http.RequestOptions = {
      hostname: proxy.host,
      port: proxy.port,
      method: options.method,
      path: url.href,
      timeout: options.timeoutMs,
      // url.host сохраняет порт, когда он нестандартный — Host должен его нести.
      headers: { Host: url.host },
    };

    if (proxy.username && proxy.password) {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
      reqOptions.headers = {
        ...reqOptions.headers,
        "Proxy-Authorization": `Basic ${auth}`,
      };
    }

    let settled = false;
    const done = (result: TransportResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = http.request(reqOptions, (res) => {
      const status = res.statusCode ?? 0;

      if (options.method === "HEAD") {
        res.resume();
        done({ status, elapsedMs: Date.now() - start });
        return;
      }

      if (!(status >= 200 && status < 300)) {
        res.destroy();
        done({ status, elapsedMs: Date.now() - start });
        return;
      }

      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > options.maxBodyBytes) {
          res.destroy();
          done({ status, error: "Response too large", elapsedMs: Date.now() - start });
        }
      });
      res.on("end", () => done({ status, body, elapsedMs: Date.now() - start }));
    });

    req.on("timeout", () => {
      req.destroy();
      done({ error: "Timeout", elapsedMs: Date.now() - start });
    });

    req.on("error", (err) => done({ error: sanitizeError(err), elapsedMs: Date.now() - start }));
    req.end();
  });
}

async function viaSocks(
  proxy: ProxyRow,
  url: URL,
  options: TransportOptions,
  start: number
): Promise<TransportResult> {
  // Ошибки рукопожатия и авторизации приходят отсюда как исключения
  // с разными сообщениями — их различает вызывающий код.
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: 5,
      userId: proxy.username ?? undefined,
      password: proxy.password ?? undefined,
    },
    command: "connect",
    destination: {
      host: url.hostname,
      port: Number(url.port) || 80,
    },
    timeout: options.timeoutMs,
  });

  const wantBody = options.method === "GET";

  return new Promise<TransportResult>((resolve) => {
    let raw = "";
    let settled = false;

    const done = (result: TransportResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const fromRaw = (parsed: RawResponse | null): TransportResult => {
      const elapsedMs = Date.now() - start;
      if (!parsed || parsed.status === 0) return { error: "Malformed response", elapsedMs };
      if (!wantBody) return { status: parsed.status, elapsedMs };
      if (parsed.body.length > options.maxBodyBytes) {
        return { status: parsed.status, error: "Response too large", elapsedMs };
      }
      return { status: parsed.status, body: parsed.body, elapsedMs };
    };

    socket.setTimeout(options.timeoutMs);
    socket.setEncoding("utf8");
    socket.on("timeout", () => done({ error: "Timeout", elapsedMs: Date.now() - start }));
    socket.on("error", (err) =>
      done({ error: sanitizeError(err), elapsedMs: Date.now() - start })
    );

    socket.on("data", (chunk: string) => {
      raw += chunk;

      const parsed = parseRawSocksResponse(raw, wantBody);
      if (parsed !== null) {
        done(fromRaw(parsed));
        return;
      }

      if (raw.length > RAW_LIMIT) {
        done(fromRaw(parseFinalRawResponse(raw)));
      }
    });

    socket.on("end", () => done(fromRaw(parseFinalRawResponse(raw))));

    socket.write(
      `${options.method} ${url.pathname}${url.search} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        `Connection: close\r\n\r\n`
    );
  });
}

/**
 * Открыть соединение через прокси и получить HTTP-ответ.
 * Транспорт выбирается по proxy.type. Никогда не бросает —
 * любая ошибка приходит полем error.
 */
export async function httpViaProxy(
  proxy: ProxyRow,
  url: URL,
  options: TransportOptions
): Promise<TransportResult> {
  const start = Date.now();
  try {
    return proxy.type === "socks5"
      ? await viaSocks(proxy, url, options, start)
      : await viaHttp(proxy, url, options, start);
  } catch (err) {
    return { error: sanitizeError(err), elapsedMs: Date.now() - start };
  }
}
