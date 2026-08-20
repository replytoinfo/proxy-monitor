const PING_TIMEOUT = 5_000;

/**
 * Пинг внешнего watchdog. Идёт напрямую, не через прокси, и в общий
 * лимит конкурентности не входит.
 *
 * Адрес содержит секретный идентификатор, поэтому в лог не попадает
 * ни он сам, ни текст сетевой ошибки — сообщения undici могут его нести.
 * Пишется только обобщённая причина.
 */
export async function pingWatchdog(url: string, timeoutMs = PING_TIMEOUT): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Тело не читаем, соединение закрываем.
    await res.body?.cancel();

    if (res.status >= 200 && res.status < 400) return true;

    console.warn(`[watchdog] ping failed: HTTP ${res.status}`);
    return false;
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error";
    console.warn(`[watchdog] ping failed: ${reason}`);
    return false;
  }
}
