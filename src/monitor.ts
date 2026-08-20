import { config } from "./config.js";
import {
  getEnabledProxies,
  saveCheck,
  getConsecutiveFailCount,
  getLastAlert,
  saveAlert,
  deleteOldChecks,
  getLastCheck,
  getIpState,
  upsertIpState,
  saveIpChangeAndState,
  deleteOldIpChanges,
  toSqlTime,
  fromSqlTime,
  getProbeFailure,
  upsertProbeFailure,
  clearProbeFailure,
  saveSystemAlert,
  getLastSystemAlert,
  type ProxyRow,
} from "./db.js";
import { checkWithFallback } from "./checker/liveness.js";
import { createSemaphore, runAllSettled } from "./pool.js";
import {
  sendMessage,
  formatDownAlert,
  formatReminderAlert,
  formatRecoveryAlert,
  formatStaleIpAlert,
  formatRotationOkAlert,
  formatIpProbeDownAlert,
  formatIpProbeOkAlert,
  formatMassDownAlert,
  formatMassRecoveryAlert,
  formatIpProbeSystemDownAlert,
  formatIpProbeSystemOkAlert,
} from "./telegram.js";
import { fetchExternalIp } from "./checker/ip.js";
import { nextIpState, isRotationStale, nextProbeFailure } from "./rotation.js";
import { pingWatchdog } from "./watchdog.js";

const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

let checkTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let ipTimer: ReturnType<typeof setInterval> | null = null;
let ipCheckRunning = false;
let checksRunning = false;

const downSince = new Map<number, number>();

// --- Shared concurrency pool ---

/**
 * Один потолок на все исходящие проверки сразу: циклы доступности
 * и ротации делят его между собой. Слот занимается ровно один раз
 * на проверку одной прокси — внутри проверки вложенных захватов нет.
 */
const checkPool = createSemaphore(config.MAX_CONCURRENT_CHECKS);

// --- Check logic ---

async function checkProxy(proxy: ProxyRow, primary: URL, fallback: URL | null) {
  const result = await checkWithFallback(proxy, primary, fallback);

  const status = result.ok ? "up" : "down";
  saveCheck(proxy.id, status, result.responseTime, result.error ?? null);

  return { proxy, status, usedFallback: result.usedFallback };
}

/**
 * Решение о массовом падении и его отправка. Возвращает true, если
 * индивидуальные down этого цикла нужно подавить.
 *
 * Подавленный down не пишется в alerts: иначе появятся напоминания
 * и recovery для сообщения, которого пользователь не видел.
 */
async function handleMassOutage(
  checked: Array<{ status: string }>,
  incomplete: boolean
): Promise<boolean> {
  // Неполный цикл и цикл без прокси массовым выводом не считаются.
  if (incomplete || checked.length === 0) return false;

  const last = getLastSystemAlert("mass")?.type;
  const allDown = checked.length >= 2 && checked.every((c) => c.status === "down");

  if (allDown) {
    if (last !== "mass_down") {
      console.log(`[monitor] All ${checked.length} proxies down — sending mass_down`);
      if (await sendMessage(formatMassDownAlert(checked.length))) {
        saveSystemAlert("mass_down");
      }
    }
    return true;
  }

  const upCount = checked.filter((c) => c.status === "up").length;
  if (last === "mass_down" && upCount > 0) {
    console.log("[monitor] Mass outage over — sending mass_recovery");
    if (await sendMessage(formatMassRecoveryAlert(upCount, checked.length))) {
      saveSystemAlert("mass_recovery");
    }
    // Переходный цикл: оставшиеся лежать прокси получат обычные
    // индивидуальные алерты со следующего цикла.
    return true;
  }

  return false;
}

export async function runChecks() {
  if (checksRunning) {
    console.warn("[monitor] Previous check still running — skipping tick");
    return;
  }
  checksRunning = true;

  try {
    const proxies = getEnabledProxies();
    const primary = new URL(config.CHECK_URL);
    const fallback = config.CHECK_URL_FALLBACK ? new URL(config.CHECK_URL_FALLBACK) : null;

    const results = await runAllSettled(
      checkPool,
      proxies.map((proxy) => () => checkProxy(proxy, primary, fallback))
    );

    const checked: Array<{ proxy: ProxyRow; status: string; usedFallback: boolean }> = [];
    for (const settled of results) {
      if (settled.status === "rejected") {
        const reason =
          settled.reason instanceof Error ? settled.reason.message : settled.reason;
        console.error("[monitor] Proxy check failed:", reason);
        continue;
      }
      checked.push(settled.value);
    }

    // Устойчивый отказ основного адреса при рабочем запасном — только в лог.
    if (checked.some((c) => c.usedFallback && c.status === "up")) {
      console.log("[monitor] primary check URL failing, fallback in use");
    }

    const incomplete = results.some((settled) => settled.status === "rejected");
    const suppressDown = await handleMassOutage(checked, incomplete);

    for (const { proxy, status } of checked) {
      if (status === "down") {
        if (!downSince.has(proxy.id)) {
          downSince.set(proxy.id, Date.now());
        }
        if (suppressDown) continue;

        const failCount = getConsecutiveFailCount(proxy.id, config.FAIL_THRESHOLD);
        if (failCount >= config.FAIL_THRESHOLD) {
          const lastAlert = getLastAlert(proxy.id, "uptime");
          if (!lastAlert || lastAlert.type === "recovery") {
            console.log(
              `[monitor] Proxy ${proxy.host}:${proxy.port} DOWN — sending alert`
            );
            const msg = formatDownAlert(proxy.host, proxy.port, proxy.type, proxy.label, proxy.group_name);
            const sent = await sendMessage(msg);
            if (sent) {
              saveAlert(proxy.id, "down");
            }
          } else if (lastAlert.type === "down" && config.REMINDER_INTERVAL > 0) {
            const alertTime = new Date(lastAlert.sent_at + "Z").getTime();
            if (Date.now() - alertTime >= config.REMINDER_INTERVAL) {
              const downStart = downSince.get(proxy.id) ?? alertTime;
              const downtimeMs = Date.now() - downStart;
              console.log(
                `[monitor] Proxy ${proxy.host}:${proxy.port} still DOWN — reminder`
              );
              const msg = formatReminderAlert(proxy.host, proxy.port, proxy.type, downtimeMs, proxy.label, proxy.group_name);
              const sent = await sendMessage(msg);
              if (sent) {
                saveAlert(proxy.id, "down");
              }
            }
          }
        }
      } else {
        const lastAlert = getLastAlert(proxy.id, "uptime");
        if (lastAlert?.type === "down") {
          const downStart = downSince.get(proxy.id) ?? Date.now();
          const downtimeMs = Date.now() - downStart;
          console.log(
            `[monitor] Proxy ${proxy.host}:${proxy.port} RECOVERED after ${Math.round(downtimeMs / 1000)}s`
          );
          const msg = formatRecoveryAlert(
            proxy.host,
            proxy.port,
            proxy.type,
            downtimeMs,
            proxy.label,
            proxy.group_name
          );
          const sent = await sendMessage(msg);
          if (sent) {
            saveAlert(proxy.id, "recovery");
          }
        }
        downSince.delete(proxy.id);
      }
    }

    // Пинг только после полного цикла: неполный не подтверждает живость проверок.
    if (!incomplete && config.HEALTHCHECK_URL) {
      await pingWatchdog(config.HEALTHCHECK_URL);
    }
  } finally {
    checksRunning = false;
  }
}

// --- IP rotation ---

/**
 * Опрашиваем только те прокси, чей последний liveness-результат — up
 * и достаточно свежий: если планировщик проверок встал, старый up
 * в БД не должен провоцировать расход трафика.
 */
function proxiesForIpCheck(): ProxyRow[] {
  const freshness = 2 * config.CHECK_INTERVAL;
  const now = Date.now();

  return getEnabledProxies().filter((proxy) => {
    const last = getLastCheck(proxy.id);
    if (!last || last.status !== "up") return false;
    return now - new Date(last.checked_at + "Z").getTime() <= freshness;
  });
}

type IpProbeOutcome =
  | { kind: "failed"; proxy: ProxyRow; fails: number; error: string }
  | {
      kind: "probed";
      proxy: ProxyRow;
      state: { ip: string; ipSince: number; lastProbeAt: number };
      changed: boolean;
      baseline: boolean;
      wasStale: boolean;
      isStale: boolean;
      recovered: boolean;
      prev?: { ip: string; ipSince: number; lastProbeAt: number };
      now: number;
    };

async function checkProxyIp(proxy: ProxyRow): Promise<IpProbeOutcome> {
  const result = await fetchExternalIp(proxy);
  const now = Date.now();

  if (!result.ip) {
    const error = result.error ?? "Unknown error";
    console.log(`[monitor] IP probe failed for ${proxy.host}:${proxy.port} — ${error}`);

    const row = getProbeFailure(proxy.id);
    const prevFailure = row
      ? {
          fails: row.fails,
          since: fromSqlTime(row.since),
          lastFailedAt: fromSqlTime(row.last_failed_at),
        }
      : undefined;

    const next = nextProbeFailure(prevFailure, now, config.IP_CHECK_INTERVAL);
    upsertProbeFailure(
      proxy.id,
      next.fails,
      toSqlTime(next.since),
      toSqlTime(next.lastFailedAt),
      error
    );

    return { kind: "failed", proxy, fails: next.fails, error };
  }

  // Читается до clearProbeFailure: восстановление объявляется по последнему алерту.
  const recovered = getLastAlert(proxy.id, "probe")?.type === "ip_probe_down";
  clearProbeFailure(proxy.id);

  const row = getIpState(proxy.id);
  const prev = row
    ? {
        ip: row.ip,
        ipSince: fromSqlTime(row.ip_since),
        lastProbeAt: fromSqlTime(row.last_probe_at),
      }
    : undefined;

  // wasStale читается до записи — он зависит только от последнего алерта, не от ip_since.
  const wasStale = getLastAlert(proxy.id, "rotation")?.type === "stale_ip";

  const { state, changed, baseline } = nextIpState(
    prev,
    result.ip,
    now,
    config.IP_CHECK_INTERVAL
  );

  // isStale считается по state.ipSince (уже после nextIpState): при разрыве
  // наблюдения nextIpState сбрасывает ipSince = now, поэтому ложного stale не будет.
  const isStale = isRotationStale(state.ipSince, now, config.ROTATION_MAX_AGE);

  if (changed) {
    saveIpChangeAndState(proxy.id, state.ip, toSqlTime(state.ipSince), toSqlTime(state.lastProbeAt));
  } else {
    upsertIpState(proxy.id, state.ip, toSqlTime(state.ipSince), toSqlTime(state.lastProbeAt));
  }

  return { kind: "probed", proxy, state, changed, baseline, wasStale, isStale, recovered, prev, now };
}

/**
 * Решение о массовом провале IP-проб. Возвращает true, если индивидуальные
 * ip_probe_down этого цикла нужно подавить (в alerts они тоже не пишутся).
 */
async function handleProbeSystemOutage(
  outcomes: IpProbeOutcome[],
  incomplete: boolean
): Promise<boolean> {
  if (incomplete || outcomes.length === 0) return false;

  const last = getLastSystemAlert("ip_probe")?.type;
  const failedCount = outcomes.filter((o) => o.kind === "failed").length;
  const allFailed = outcomes.length >= 2 && failedCount === outcomes.length;

  if (allFailed) {
    if (last !== "ip_probe_system_down") {
      console.log(
        `[monitor] IP probe failed for all ${outcomes.length} proxies — sending ip_probe_system_down`
      );
      if (await sendMessage(formatIpProbeSystemDownAlert(outcomes.length))) {
        saveSystemAlert("ip_probe_system_down");
      }
    }
    return true;
  }

  const okCount = outcomes.length - failedCount;
  if (last === "ip_probe_system_down" && okCount > 0) {
    console.log("[monitor] IP probes recovered — sending ip_probe_system_ok");
    if (await sendMessage(formatIpProbeSystemOkAlert(okCount, outcomes.length))) {
      saveSystemAlert("ip_probe_system_ok");
    }
    return true;
  }

  return false;
}

export async function runIpChecks() {
  if (config.ROTATION_MAX_AGE === 0) return;

  if (ipCheckRunning) {
    console.warn("[monitor] Previous IP check still running — skipping tick");
    return;
  }
  ipCheckRunning = true;

  try {
    const proxies = proxiesForIpCheck();
    if (proxies.length === 0) return;

    const results = await runAllSettled(
      checkPool,
      proxies.map((proxy) => () => checkProxyIp(proxy))
    );

    const outcomes: IpProbeOutcome[] = [];
    for (const settled of results) {
      if (settled.status === "rejected") {
        const reason =
          settled.reason instanceof Error ? settled.reason.message : settled.reason;
        console.error("[monitor] IP check failed:", reason);
        continue;
      }
      outcomes.push(settled.value);
    }

    const incomplete = results.some((settled) => settled.status === "rejected");
    const suppressProbeDown = await handleProbeSystemOutage(outcomes, incomplete);

    for (const outcome of outcomes) {
      if (outcome.kind === "failed") {
        const { proxy, fails, error } = outcome;
        if (
          !suppressProbeDown &&
          fails >= config.IP_PROBE_FAIL_THRESHOLD &&
          getLastAlert(proxy.id, "probe")?.type !== "ip_probe_down"
        ) {
          console.log(
            `[monitor] Proxy ${proxy.host}:${proxy.port} IP probe blind for ${fails} runs`
          );
          const msg = formatIpProbeDownAlert(
            proxy.host,
            proxy.port,
            proxy.type,
            fails,
            error,
            proxy.label,
            proxy.group_name
          );
          if (await sendMessage(msg)) saveAlert(proxy.id, "ip_probe_down");
        }
        continue;
      }

      const { proxy, state, changed, baseline, wasStale, isStale, recovered, prev, now } =
        outcome;

      if (recovered) {
        console.log(`[monitor] Proxy ${proxy.host}:${proxy.port} IP probe recovered`);
        const msg = formatIpProbeOkAlert(
          proxy.host,
          proxy.port,
          proxy.type,
          state.ip,
          proxy.label,
          proxy.group_name
        );
        if (await sendMessage(msg)) saveAlert(proxy.id, "ip_probe_ok");
      }

      if (baseline || !prev) continue;

      if (!wasStale && isStale) {
        const ageMs = now - prev.ipSince;
        console.log(
          `[monitor] Proxy ${proxy.host}:${proxy.port} IP STALE — ${prev.ip} for ${Math.round(ageMs / 60_000)}m`
        );
        const msg = formatStaleIpAlert(
          proxy.host,
          proxy.port,
          proxy.type,
          prev.ip,
          ageMs,
          proxy.label,
          proxy.group_name
        );
        if (await sendMessage(msg)) saveAlert(proxy.id, "stale_ip");
      } else if (wasStale && changed) {
        console.log(
          `[monitor] Proxy ${proxy.host}:${proxy.port} rotation resumed — ${state.ip}`
        );
        const msg = formatRotationOkAlert(
          proxy.host,
          proxy.port,
          proxy.type,
          state.ip,
          proxy.label,
          proxy.group_name
        );
        if (await sendMessage(msg)) saveAlert(proxy.id, "rotation_ok");
      }
    }
  } finally {
    ipCheckRunning = false;
  }
}

export function startMonitor() {
  console.log(
    `[monitor] Starting — interval: ${config.CHECK_INTERVAL}ms, threshold: ${config.FAIL_THRESHOLD} fails, concurrency: ${config.MAX_CONCURRENT_CHECKS}`
  );
  console.log(
    config.HEALTHCHECK_URL
      ? "[monitor] External watchdog enabled"
      : "[monitor] External watchdog disabled (HEALTHCHECK_URL not set)"
  );

  runChecks().catch((err) => console.error("[monitor] Check error:", err));

  checkTimer = setInterval(() => {
    runChecks().catch((err) => console.error("[monitor] Check error:", err));
  }, config.CHECK_INTERVAL);

  cleanupTimer = setInterval(() => {
    try {
      const result = deleteOldChecks(24);
      if (result.changes > 0) {
        console.log(`[monitor] Cleaned up ${result.changes} old checks`);
      }
      const ipResult = deleteOldIpChanges(7);
      if (ipResult.changes > 0) {
        console.log(`[monitor] Cleaned up ${ipResult.changes} old IP changes`);
      }
    } catch (err) {
      console.error("[monitor] Cleanup error:", err instanceof Error ? err.message : err);
    }
  }, CLEANUP_INTERVAL);

  if (config.ROTATION_MAX_AGE === 0) {
    console.log("[monitor] IP rotation checks disabled (ROTATION_MAX_AGE=0)");
  } else if (config.IP_ECHO_URLS.length === 0) {
    console.error("[monitor] IP rotation checks disabled — no valid IP_ECHO_URL");
  } else {
    console.log(
      `[monitor] IP rotation checks — interval: ${config.IP_CHECK_INTERVAL}ms, max age: ${config.ROTATION_MAX_AGE}ms`
    );
    // Первый прогон не сразу: при старте у прокси ещё нет свежего up-статуса.
    ipTimer = setInterval(() => {
      runIpChecks().catch((err) => console.error("[monitor] IP check error:", err));
    }, config.IP_CHECK_INTERVAL);
  }
}

export function stopMonitor() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (ipTimer) {
    clearInterval(ipTimer);
    ipTimer = null;
  }
  console.log("[monitor] Stopped");
}
