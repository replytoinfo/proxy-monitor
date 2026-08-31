function envRequired(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`[config] Missing required env: ${name}`);
    process.exit(1);
  }
  return val;
}

function envInt(name: string, fallback: number, min?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const val = parseInt(raw, 10);
  if (isNaN(val)) return fallback;
  if (min !== undefined && val < min) return min;
  return val;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Порог залипания должен быть не меньше двух циклов опроса,
 * иначе он срабатывает раньше, чем проходит хотя бы один цикл наблюдения.
 */
export function resolveRotationMaxAge(maxAge: number, checkInterval: number): number {
  if (maxAge === 0) return 0;
  const floor = 2 * checkInterval;
  if (maxAge < floor) {
    console.warn(
      `[config] ROTATION_MAX_AGE=${maxAge} is below 2×IP_CHECK_INTERVAL — raised to ${floor}`
    );
    return floor;
  }
  return maxAge;
}

/** Проверяемые адреса — только http:, поддержка https: в проверках не входит в объём. */
export function validateCheckUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Watchdog — внешний сервис, ему https: разрешён. */
export function validateWatchdogUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Список эхо-сервисов через запятую. Невалидные элементы отбрасываются
 * с предупреждением, дубликаты схлопываются по нормализованному href.
 */
export function parseEchoUrls(raw: string): string[] {
  const seen = new Set<string>();

  for (const item of raw.split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    const url = validateCheckUrl(trimmed);
    if (!url) {
      console.warn(`[config] IP_ECHO_URL: dropping invalid entry "${trimmed}" (http: only)`);
      continue;
    }
    seen.add(url.href);
  }

  return [...seen];
}

function requireCheckUrl(raw: string): string {
  const url = validateCheckUrl(raw);
  if (!url) {
    console.error(`[config] CHECK_URL must be a valid http: URL — got "${raw}". Monitoring is pointless without it.`);
    process.exit(1);
  }
  return url.href;
}

export function optionalFallbackUrl(raw: string): string | null {
  if (!raw.trim()) return null;
  const url = validateCheckUrl(raw);
  if (!url) {
    console.warn(`[config] CHECK_URL_FALLBACK is not a valid http: URL — running without confirmation`);
    return null;
  }
  return url.href;
}

function optionalWatchdogUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const url = validateWatchdogUrl(raw);
  if (!url) {
    console.warn(`[config] HEALTHCHECK_URL is not a valid http(s): URL — watchdog disabled`);
    return null;
  }
  return url.href;
}

export const config = {
  TELEGRAM_BOT_TOKEN: envRequired("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_CHAT_ID: envRequired("TELEGRAM_CHAT_ID"),

  CHECK_INTERVAL: envInt("CHECK_INTERVAL", 45_000, 5_000),
  FAIL_THRESHOLD: envInt("FAIL_THRESHOLD", 4, 1),
  MAX_PROXIES: envInt("MAX_PROXIES", 100, 1),
  MAX_ADD_BODY_BYTES: envInt("MAX_ADD_BODY_BYTES", 10_000, 100),
  MAX_CONCURRENT_CHECKS: envInt("MAX_CONCURRENT_CHECKS", 10, 1),
  /** Глубина истории проверок. Она же окно показателя quality. */
  CHECKS_RETENTION_HOURS: envInt("CHECKS_RETENTION_HOURS", 168, 1),
  ALLOW_PRIVATE_TARGETS: envBool("ALLOW_PRIVATE_TARGETS", false),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "",
  REMINDER_INTERVAL: envInt("REMINDER_INTERVAL", 12, 0) * 3_600_000,
  IP_CHECK_INTERVAL: envInt("IP_CHECK_INTERVAL", 300_000, 60_000),
  ROTATION_MAX_AGE: resolveRotationMaxAge(
    envInt("ROTATION_MAX_AGE", 2_700_000, 0),
    envInt("IP_CHECK_INTERVAL", 300_000, 60_000)
  ),
  IP_ECHO_URLS: parseEchoUrls(
    process.env.IP_ECHO_URL ?? "http://api.ipify.org,http://ifconfig.me/ip"
  ),
  // Адреса-заглушки провайдеров CDN: отдают 204 без тела и держатся годами.
  // Основной и запасной берём у разных компаний — общий отказ маловероятен.
  CHECK_URL: requireCheckUrl(process.env.CHECK_URL ?? "http://cp.cloudflare.com/generate_204"),
  CHECK_URL_FALLBACK: optionalFallbackUrl(
    process.env.CHECK_URL_FALLBACK ?? "http://www.gstatic.com/generate_204"
  ),
  IP_PROBE_FAIL_THRESHOLD: envInt("IP_PROBE_FAIL_THRESHOLD", 3, 1),
  HEALTHCHECK_URL: optionalWatchdogUrl(process.env.HEALTHCHECK_URL),
} as const;
