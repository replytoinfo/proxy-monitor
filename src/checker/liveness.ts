import type { ProxyRow } from "../db.js";
import { validateHost } from "../net-policy.js";
import { MAX_ERROR_LEN } from "./errors.js";
import { httpViaProxy } from "./transport.js";

export interface CheckResult {
  ok: boolean;
  responseTime: number;
  error?: string;
}

const TIMEOUT = 10_000;

/**
 * Проверка проходимости: через прокси открывается настоящее соединение
 * и запрашивается HEAD. Для SOCKS5 это принципиально — рукопожатие
 * и авторизация проходят и у прокси, которая трафик не пропускает.
 * Транспорт выбирает httpViaProxy по proxy.type.
 *
 * Трафик: ~300-500 байт на проверку.
 */
export async function checkLiveness(
  proxy: ProxyRow,
  url: URL,
  timeoutMs = TIMEOUT
): Promise<CheckResult> {
  const blocked = await validateHost(proxy.host);
  if (blocked) {
    return { ok: false, responseTime: 0, error: blocked.slice(0, MAX_ERROR_LEN) };
  }

  const res = await httpViaProxy(proxy, url, {
    method: "HEAD",
    maxBodyBytes: 0,
    timeoutMs,
  });

  if (res.error) {
    return { ok: false, responseTime: res.elapsedMs, error: res.error };
  }

  const status = res.status ?? 0;
  if (status >= 200 && status < 400) {
    return { ok: true, responseTime: res.elapsedMs };
  }

  return { ok: false, responseTime: res.elapsedMs, error: `HTTP ${status || "?"}` };
}

export interface LivenessResult extends CheckResult {
  /** Запасной адрес был задействован — значит основной провалился. */
  usedFallback: boolean;
}

/**
 * Прокси объявляется down только после провала обоих адресов.
 * Запасная попытка делается лишь после провала основной, поэтому
 * здоровые прокси лишнего трафика не получают.
 *
 * Слот пула снаружи уже занят: второй попытки под отдельным слотом нет.
 */
export async function checkWithFallback(
  proxy: ProxyRow,
  primary: URL,
  fallback: URL | null
): Promise<LivenessResult> {
  const first = await checkLiveness(proxy, primary);
  if (first.ok || !fallback) {
    return { ...first, usedFallback: false };
  }

  const second = await checkLiveness(proxy, fallback);
  const responseTime = first.responseTime + second.responseTime;

  if (second.ok) {
    return { ok: true, responseTime, usedFallback: true };
  }

  return {
    ok: false,
    responseTime,
    error: `основной: ${first.error ?? "?"}; запасной: ${second.error ?? "?"}`.slice(
      0,
      MAX_ERROR_LEN
    ),
    usedFallback: true,
  };
}
