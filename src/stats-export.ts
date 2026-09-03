import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getProxies, getQualityAll, DATA_DIR } from "./db.js";

export interface StatsProxy {
  id: number;
  label: string | null;
  host: string;
  port: number;
  type: string;
  enabled: boolean;
  total: number;
  down: number;
  fallback: number;
  /** Доля проверок со статусом up, в процентах; null без проверок. */
  uptime: number | null;
  /** Доля проверок без down и без fallback; null без проверок. */
  quality: number | null;
  median_ms: number | null;
}

export interface Stats {
  generated_at: string;
  window_hours: number;
  proxies: StatsProxy[];
}

export const STATS_PATH = join(DATA_DIR, "stats.json");

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Статистика всех прокси за окно — то же, что видит /quality, без секретов. */
export function buildStats(hours = 24, now = new Date()): Stats {
  const quality = new Map(getQualityAll(hours).map((q) => [q.proxy_id, q]));

  const proxies = getProxies().map((p): StatsProxy => {
    const q = quality.get(p.id);
    const total = q?.total ?? 0;
    return {
      id: p.id,
      label: p.label ?? p.group_name ?? null, // та же цепочка имени, что в /list
      host: p.host,
      port: p.port,
      type: p.type,
      enabled: p.enabled === 1,
      total,
      down: q?.down ?? 0,
      fallback: q?.fallback ?? 0,
      uptime: q && total > 0 ? round1(((total - q.down) / total) * 100) : null,
      quality: q && total > 0 ? round1(q.quality) : null,
      median_ms: q?.medianMs ?? null,
    };
  });

  return { generated_at: now.toISOString(), window_hours: hours, proxies };
}

/**
 * Атомарная запись: tmp в той же папке + rename, чтобы читатель по ssh
 * никогда не увидел половину файла. Ошибку не глотаем — решает вызывающий.
 */
export function writeStats(path = STATS_PATH, hours = 24): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(buildStats(hours), null, 1), { mode: 0o600 });
  renameSync(tmp, path);
}
