import type { ProxyRow } from "./db.js";
import type { SpeedResult } from "./checker/speed.js";
import { escapeHtml } from "./html.js";

export interface SpeedTargets {
  targets: ProxyRow[];
  error?: string;
}

/**
 * Число — id (в том числе паузнутая: полезно проверить перед /resume),
 * иначе группа (только активные), пусто — все активные.
 */
export function selectSpeedTargets(arg: string, proxies: ProxyRow[]): SpeedTargets {
  const trimmed = arg.trim();

  if (!trimmed) {
    return { targets: proxies.filter((p) => p.enabled) };
  }

  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    const proxy = proxies.find((p) => p.id === id);
    if (!proxy) return { targets: [], error: `Прокси #${id} не найдена.` };
    return { targets: [proxy] };
  }

  const group = proxies.filter(
    (p) => p.enabled && p.group_name?.toLowerCase() === trimmed.toLowerCase()
  );
  if (group.length === 0) {
    return { targets: [], error: `Нет активных прокси в группе "${escapeHtml(trimmed)}".` };
  }
  return { targets: group };
}

function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

function formatLine(proxy: ProxyRow, r: SpeedResult): string {
  const name = proxy.label ?? proxy.group_name ?? `${proxy.host}:${proxy.port}`;
  const head = `<b>#${proxy.id}</b> ${escapeHtml(name)}`;

  if (r.error) return `${head} — ошибка: ${escapeHtml(r.error)}`;

  const mbits = ((r.bytes * 8) / Math.max(r.ms, 1) / 1000).toFixed(1);
  const size = formatSize(r.bytes);
  const secs = (r.ms / 1000).toFixed(1);

  if (r.complete) return `${head} — ${mbits} Мбит/с (${size} за ${secs} с)`;
  return `${head} — ≈${mbits} Мбит/с (${size} за ${secs} с, не завершено)`;
}

export function formatSpeedReport(
  entries: Array<{ proxy: ProxyRow; result: SpeedResult }>
): string {
  return ["<b>Скорость</b>", ...entries.map((e) => formatLine(e.proxy, e.result))].join("\n");
}

let running = false;

export function isSpeedRunning(): boolean {
  return running;
}

/**
 * Последовательный прогон замеров и отправка отчёта одним сообщением.
 * false — замер уже идёт. Последовательно, потому что параллельные
 * скачивания делят исходящий канал сервера и портят чистоту замера.
 */
export async function runSpeed(
  targets: ProxyRow[],
  measure: (p: ProxyRow) => Promise<SpeedResult>,
  send: (text: string) => Promise<unknown>
): Promise<boolean> {
  if (running) return false;
  running = true;
  try {
    const entries: Array<{ proxy: ProxyRow; result: SpeedResult }> = [];
    for (const proxy of targets) {
      entries.push({ proxy, result: await measure(proxy) });
    }
    await send(formatSpeedReport(entries));
    return true;
  } finally {
    running = false;
  }
}
