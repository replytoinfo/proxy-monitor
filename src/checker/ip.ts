import * as net from "node:net";
import type { ProxyRow } from "../db.js";
import { config } from "../config.js";
import { validateHost } from "../net-policy.js";
import { MAX_ERROR_LEN } from "./errors.js";
import { httpViaProxy } from "./transport.js";

export interface IpResult {
  ip?: string;
  error?: string;
}

/** Столько же, сколько у проверки доступности: медленный прокси не должен
 *  выглядеть слепым там, где liveness его считает живым. */
const TIMEOUT = 10_000;
/** Потолок на весь перебор адресов — вместо деления бюджета между ними. */
const TOTAL_BUDGET = 20_000;
const BODY_LIMIT = 64;

export function parseIpBody(body: string): IpResult {
  const text = body.slice(0, BODY_LIMIT).trim();
  if (!net.isIP(text)) return { error: "Invalid IP response" };
  return { ip: text };
}

/**
 * Узнать внешний IP прокси, перебирая эхо-сервисы по порядку до первого успеха.
 * Каждая попытка получает полный таймаут, а разрастание перебора ограничивает
 * общий дедлайн: делить бюджет между адресами нельзя — доля от него оказывалась
 * меньше обычной задержки мобильного прокси на холодную.
 * Трафик: ~400 байт на успешный запрос.
 */
export async function fetchExternalIp(proxy: ProxyRow): Promise<IpResult> {
  const blocked = await validateHost(proxy.host);
  if (blocked) return { error: blocked.slice(0, MAX_ERROR_LEN) };

  const urls = config.IP_ECHO_URLS;
  if (urls.length === 0) return { error: "No echo URL configured" };

  const deadline = Date.now() + TOTAL_BUDGET;
  const errors: string[] = [];

  for (const raw of urls) {
    const left = deadline - Date.now();
    if (left < 1_000) {
      errors.push("budget exhausted");
      break;
    }

    const url = new URL(raw);
    const res = await httpViaProxy(proxy, url, {
      method: "GET",
      maxBodyBytes: BODY_LIMIT,
      timeoutMs: Math.min(TIMEOUT, left),
    });

    if (res.error) {
      errors.push(`${url.hostname}: ${res.error}`);
      continue;
    }

    const status = res.status ?? 0;
    if (!(status >= 200 && status < 300)) {
      errors.push(`${url.hostname}: HTTP ${status || "?"}`);
      continue;
    }

    const parsed = parseIpBody(res.body ?? "");
    if (parsed.ip) return parsed;
    errors.push(`${url.hostname}: ${parsed.error}`);
  }

  return { error: errors.join("; ").slice(0, MAX_ERROR_LEN) };
}
