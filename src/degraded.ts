/**
 * Правило деградации прокси. Чистые функции без доступа к БД и config —
 * одни и те же формулы использует монитор и бэктест на архиве проверок.
 */

export interface DegradedParams {
  /** Успех медленнее этого порога (мс) считается плохой проверкой. */
  slowMs: number;
  /** Минимум проверок в окне, чтобы выносить вердикт. */
  minChecks: number;
  /** Доля плохих проверок, с которой начинается деградация. */
  ratio: number;
  /** Доля плохих проверок, ниже которой деградация считается прошедшей (гистерезис). */
  recoverRatio: number;
}

export interface WindowCheck {
  status: string;
  response_time: number | null;
}

export interface WindowStats {
  total: number;
  /** failed + slow. */
  bad: number;
  /** status != 'up'. */
  failed: number;
  /** status = 'up', но отклик выше порога (включая успех через запасной адрес). */
  slow: number;
  /** Медиана и p90 отклика среди успешных проверок; null, если успешных нет. */
  medianMs: number | null;
  p90Ms: number | null;
}

export type DegradedVerdict = "degrade" | "recover" | "none";

export function isSlow(check: WindowCheck, slowMs: number): boolean {
  return check.status === "up" && (check.response_time ?? 0) > slowMs;
}

/** Нижний процентиль по ранжированию «ближайший ранг»: p90 из 10 значений — девятое. */
function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

export function summarizeWindow(checks: WindowCheck[], slowMs: number): WindowStats {
  let failed = 0;
  let slow = 0;
  const upTimes: number[] = [];
  for (const c of checks) {
    if (c.status !== "up") failed++;
    else {
      if (isSlow(c, slowMs)) slow++;
      if (c.response_time !== null) upTimes.push(c.response_time);
    }
  }
  upTimes.sort((a, b) => a - b);
  return {
    total: checks.length,
    bad: failed + slow,
    failed,
    slow,
    medianMs: percentile(upTimes, 0.5),
    p90Ms: percentile(upTimes, 0.9),
  };
}

/**
 * Переход состояния. Гистерезис: войти в деградацию можно при доле >= ratio,
 * выйти — только при доле < recoverRatio; между порогами состояние не меняется.
 * Окно с числом проверок меньше minChecks вердикта не даёт.
 */
export function evaluateDegraded(
  stats: WindowStats,
  degraded: boolean,
  p: DegradedParams
): DegradedVerdict {
  if (stats.total < p.minChecks) return "none";
  const share = stats.bad / stats.total;
  if (!degraded && share >= p.ratio) return "degrade";
  if (degraded && share < p.recoverRatio) return "recover";
  return "none";
}
