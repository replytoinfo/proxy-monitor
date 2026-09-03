import Database, { type Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt, decrypt, isEncrypted, isEncryptionEnabled } from "./crypto.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, "proxy-monitor.db");

// Secure directory and file permissions
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const db: DatabaseType = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Set DB file permissions (owner-only)
try {
  chmodSync(DB_PATH, 0o600);
} catch {
  // May fail on some platforms (e.g., Windows) — non-critical
}

// --- Migrations ---

db.exec(`
  CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'http',
    username TEXT,
    password TEXT,
    label TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    response_time INTEGER,
    error TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_checks_proxy_time ON checks(proxy_id, checked_at DESC);

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_alerts_proxy ON alerts(proxy_id, sent_at DESC);

  CREATE TABLE IF NOT EXISTS ip_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ip_changes_proxy ON ip_changes(proxy_id, changed_at DESC);

  CREATE TABLE IF NOT EXISTS proxy_ip_state (
    proxy_id INTEGER PRIMARY KEY REFERENCES proxies(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    ip_since TEXT NOT NULL,
    last_probe_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ip_probe_failures (
    proxy_id INTEGER PRIMARY KEY REFERENCES proxies(id) ON DELETE CASCADE,
    fails INTEGER NOT NULL,
    since TEXT NOT NULL,
    last_failed_at TEXT NOT NULL,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS system_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_system_alerts_type ON system_alerts(type, sent_at DESC);
`);

// Migration: add group_name column
try {
  db.exec(`ALTER TABLE proxies ADD COLUMN group_name TEXT`);
} catch {
  // Column already exists
}

// Migration: remember whether the check fell back to the backup target.
// Записи, сделанные до этой миграции, получают 0 — доля fallback за первое
// окно после обновления будет занижена, дальше выровняется.
try {
  db.exec(`ALTER TABLE checks ADD COLUMN used_fallback INTEGER NOT NULL DEFAULT 0`);
} catch {
  // Column already exists
}

// --- Encrypt existing plaintext passwords if encryption is now enabled ---

function migrateCredentials() {
  if (!isEncryptionEnabled()) return;

  const rows = db
    .prepare(`SELECT id, password FROM proxies WHERE password IS NOT NULL`)
    .all() as Array<{ id: number; password: string }>;

  const update = db.prepare(`UPDATE proxies SET password = ? WHERE id = ?`);
  let migrated = 0;

  for (const row of rows) {
    if (!isEncrypted(row.password)) {
      update.run(encrypt(row.password), row.id);
      migrated++;
    }
  }

  if (migrated > 0) {
    console.log(`[db] Encrypted ${migrated} existing plaintext passwords`);
  }
}

migrateCredentials();

// --- Types ---

export interface ProxyRow {
  id: number;
  host: string;
  port: number;
  type: string;
  username: string | null;
  password: string | null;
  label: string | null;
  group_name: string | null;
  enabled: number;
  created_at: string;
}

export interface CheckRow {
  id: number;
  proxy_id: number;
  status: string;
  response_time: number | null;
  error: string | null;
  checked_at: string;
  /** 1, если успех получен только через запасной адрес. */
  used_fallback: number;
}

export interface AlertRow {
  id: number;
  proxy_id: number;
  type: string;
  sent_at: string;
}

export interface SystemAlertRow {
  id: number;
  type: string;
  sent_at: string;
}

export interface IpStateRow {
  proxy_id: number;
  ip: string;
  ip_since: string;
  last_probe_at: string;
}

export interface ProbeFailureRow {
  proxy_id: number;
  fails: number;
  since: string;
  last_failed_at: string;
  last_error: string | null;
}

// --- Proxies ---

const stmtInsertProxy = db.prepare(
  `INSERT INTO proxies (host, port, type, username, password, label, group_name) VALUES (?, ?, ?, ?, ?, ?, ?)`
);

const stmtGetProxies = db.prepare(`SELECT * FROM proxies ORDER BY id`);
const stmtGetProxy = db.prepare(`SELECT * FROM proxies WHERE id = ?`);
const stmtGetEnabled = db.prepare(`SELECT * FROM proxies WHERE enabled = 1`);
const stmtDeleteProxy = db.prepare(`DELETE FROM proxies WHERE id = ?`);
const stmtToggleProxy = db.prepare(
  `UPDATE proxies SET enabled = ? WHERE id = ?`
);

export function addProxy(p: {
  host: string;
  port: number;
  type: string;
  username?: string;
  password?: string;
  label?: string;
  group_name?: string;
}) {
  const encPassword = p.password ? encrypt(p.password) : null;
  return stmtInsertProxy.run(
    p.host,
    p.port,
    p.type,
    p.username ?? null,
    encPassword,
    p.label ?? null,
    p.group_name ?? null
  );
}

export function getProxies(): ProxyRow[] {
  return stmtGetProxies.all() as ProxyRow[];
}

export function getProxyById(id: number): ProxyRow | undefined {
  return stmtGetProxy.get(id) as ProxyRow | undefined;
}

/** Пароль в базе зашифрован; сетевым проверкам нужен открытый. */
export function decryptProxy(p: ProxyRow): ProxyRow {
  return { ...p, password: p.password ? decrypt(p.password) : null };
}

/**
 * Get enabled proxies with decrypted passwords for network checks.
 */
export function getEnabledProxies(): ProxyRow[] {
  return (stmtGetEnabled.all() as ProxyRow[]).map(decryptProxy);
}

export function deleteProxy(id: number) {
  return stmtDeleteProxy.run(id);
}

export function toggleProxy(id: number, enabled: boolean) {
  return stmtToggleProxy.run(enabled ? 1 : 0, id);
}

const stmtSetLabel = db.prepare(`UPDATE proxies SET label = ? WHERE id = ?`);
const stmtSetGroup = db.prepare(`UPDATE proxies SET group_name = ? WHERE id = ?`);

export function setLabel(id: number, label: string | null) {
  return stmtSetLabel.run(label, id);
}

export function setGroup(id: number, groupName: string | null) {
  return stmtSetGroup.run(groupName, id);
}

// --- Checks ---

const stmtSaveCheck = db.prepare(
  `INSERT INTO checks (proxy_id, status, response_time, error, used_fallback) VALUES (?, ?, ?, ?, ?)`
);

const stmtRecentChecks = db.prepare(
  `SELECT * FROM checks WHERE proxy_id = ? ORDER BY checked_at DESC LIMIT ?`
);

const stmtConsecutiveFails = db.prepare(`
  SELECT COUNT(*) as cnt FROM (
    SELECT status FROM checks WHERE proxy_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?
  ) WHERE status = 'down'
`);

const stmtLastCheck = db.prepare(
  `SELECT * FROM checks WHERE proxy_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1`
);

export function saveCheck(
  proxyId: number,
  status: "up" | "down",
  responseTime: number | null,
  error: string | null,
  usedFallback = false
) {
  return stmtSaveCheck.run(proxyId, status, responseTime, error, usedFallback ? 1 : 0);
}

export interface QualityRow {
  proxy_id: number;
  total: number;
  down: number;
  fallback: number;
  /** Проверок со сбоем; down и fallback на одной проверке считаются один раз. */
  bad: number;
  /** Доля проверок без сбоев, в процентах. Сбой — down либо уход в fallback. */
  quality: number;
  /** Медиана отклика; null, если ни у одной проверки нет времени. */
  medianMs: number | null;
}

const stmtQuality = db.prepare(
  `SELECT proxy_id,
          COUNT(*) AS total,
          SUM(CASE WHEN status != 'up' THEN 1 ELSE 0 END) AS down,
          SUM(CASE WHEN used_fallback = 1 THEN 1 ELSE 0 END) AS fallback,
          SUM(CASE WHEN status != 'up' OR used_fallback = 1 THEN 1 ELSE 0 END) AS bad
   FROM checks
   WHERE checked_at > datetime('now', ? || ' hours')
   GROUP BY proxy_id`
);

/**
 * Медиана отклика по каждой прокси. Отдельный запрос с оконной функцией:
 * агрегатной медианы в SQLite нет, а тянуть все отклики в память нельзя —
 * за неделю это сотня тысяч строк. При чётном числе проверок берётся
 * верхняя из двух средних: усреднять смысла нет, это не денежная величина.
 */
const stmtMedian = db.prepare(
  `SELECT proxy_id, response_time AS median FROM (
     SELECT proxy_id, response_time,
            ROW_NUMBER() OVER (PARTITION BY proxy_id ORDER BY response_time) AS rn,
            COUNT(*) OVER (PARTITION BY proxy_id) AS cnt
     FROM checks
     WHERE checked_at > datetime('now', ? || ' hours') AND response_time IS NOT NULL
   ) WHERE rn = cnt / 2 + 1`
);

/**
 * Качество каждой прокси за окно — одним запросом на всех, чтобы /list
 * не превращался в N запросов по числу прокси.
 *
 * Сбоем считается и down, и успех через запасной адрес: прокси, которая
 * доходит только через fallback, исправно показывает `up`, но теряет
 * каждый n-й запрос — без этого такая деградация остаётся невидимой.
 */
const stmtSpan = db.prepare(
  `SELECT CAST((julianday('now') - julianday(MIN(checked_at))) * 24 AS INTEGER) AS hours
   FROM checks WHERE checked_at > datetime('now', ? || ' hours')`
);

/**
 * Сколько часов истории реально накоплено, но не больше окна. Нужно, чтобы
 * /quality не обещал неделю, когда база живёт вторые сутки.
 */
export function getChecksSpanHours(windowHours: number): number {
  const row = stmtSpan.get(`-${windowHours}`) as { hours: number | null };
  return Math.min(windowHours, row.hours ?? 0);
}

export function getQualityAll(hours: number): QualityRow[] {
  const rows = stmtQuality.all(`-${hours}`) as Array<Omit<QualityRow, "quality" | "medianMs">>;

  const medians = new Map<number, number>();
  for (const m of stmtMedian.all(`-${hours}`) as Array<{ proxy_id: number; median: number }>) {
    medians.set(m.proxy_id, m.median);
  }

  return rows.map((r) => ({
    ...r,
    quality: r.total === 0 ? 0 : ((r.total - r.bad) / r.total) * 100,
    medianMs: medians.get(r.proxy_id) ?? null,
  }));
}

export function getRecentChecks(proxyId: number, limit = 10): CheckRow[] {
  return stmtRecentChecks.all(proxyId, limit) as CheckRow[];
}

export function getConsecutiveFailCount(
  proxyId: number,
  threshold: number
): number {
  const row = stmtConsecutiveFails.get(proxyId, threshold) as { cnt: number };
  return row.cnt;
}

export function getLastCheck(proxyId: number): CheckRow | undefined {
  return stmtLastCheck.get(proxyId) as CheckRow | undefined;
}

// --- IP rotation ---

/** SQLite datetime('now') format: UTC "YYYY-MM-DD HH:MM:SS". */
export function toSqlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export function fromSqlTime(value: string): number {
  return new Date(value + "Z").getTime();
}

const stmtGetIpState = db.prepare(
  `SELECT * FROM proxy_ip_state WHERE proxy_id = ?`
);

const stmtUpsertIpState = db.prepare(`
  INSERT INTO proxy_ip_state (proxy_id, ip, ip_since, last_probe_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(proxy_id) DO UPDATE SET
    ip = excluded.ip,
    ip_since = excluded.ip_since,
    last_probe_at = excluded.last_probe_at
`);

const stmtSaveIpChange = db.prepare(
  `INSERT INTO ip_changes (proxy_id, ip) VALUES (?, ?)`
);

const stmtCountIpChanges = db.prepare(`
  SELECT COUNT(*) as cnt FROM ip_changes
  WHERE proxy_id = ? AND changed_at >= datetime('now', ? || ' hours')
`);

const stmtDeleteOldIpChanges = db.prepare(
  `DELETE FROM ip_changes WHERE changed_at < datetime('now', ? || ' days')`
);

export function getIpState(proxyId: number): IpStateRow | undefined {
  return stmtGetIpState.get(proxyId) as IpStateRow | undefined;
}

export function upsertIpState(
  proxyId: number,
  ip: string,
  ipSince: string,
  lastProbeAt: string
) {
  return stmtUpsertIpState.run(proxyId, ip, ipSince, lastProbeAt);
}

export function saveIpChange(proxyId: number, ip: string) {
  return stmtSaveIpChange.run(proxyId, ip);
}

/**
 * Атомарно записывает смену IP и обновляет состояние.
 * Оба изменения видны вместе или не видны вовсе.
 */
const txnIpChangeAndState = db.transaction(
  (proxyId: number, ip: string, ipSince: string, lastProbeAt: string) => {
    stmtSaveIpChange.run(proxyId, ip);
    stmtUpsertIpState.run(proxyId, ip, ipSince, lastProbeAt);
  }
);

export function saveIpChangeAndState(
  proxyId: number,
  ip: string,
  ipSince: string,
  lastProbeAt: string
): void {
  txnIpChangeAndState(proxyId, ip, ipSince, lastProbeAt);
}

export function countIpChanges(proxyId: number, hours = 24): number {
  const row = stmtCountIpChanges.get(proxyId, `-${hours}`) as { cnt: number };
  return row.cnt;
}

export function deleteOldIpChanges(days = 7) {
  return stmtDeleteOldIpChanges.run(`-${days}`);
}

// --- IP probe failures ---

const stmtGetProbeFailure = db.prepare(
  `SELECT * FROM ip_probe_failures WHERE proxy_id = ?`
);

const stmtUpsertProbeFailure = db.prepare(`
  INSERT INTO ip_probe_failures (proxy_id, fails, since, last_failed_at, last_error)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(proxy_id) DO UPDATE SET
    fails = excluded.fails,
    since = excluded.since,
    last_failed_at = excluded.last_failed_at,
    last_error = excluded.last_error
`);

const stmtClearProbeFailure = db.prepare(
  `DELETE FROM ip_probe_failures WHERE proxy_id = ?`
);

export function getProbeFailure(proxyId: number): ProbeFailureRow | undefined {
  return stmtGetProbeFailure.get(proxyId) as ProbeFailureRow | undefined;
}

export function upsertProbeFailure(
  proxyId: number,
  fails: number,
  since: string,
  lastFailedAt: string,
  lastError: string | null
) {
  return stmtUpsertProbeFailure.run(proxyId, fails, since, lastFailedAt, lastError);
}

export function clearProbeFailure(proxyId: number) {
  return stmtClearProbeFailure.run(proxyId);
}

// --- Alerts ---

const stmtSaveAlert = db.prepare(
  `INSERT INTO alerts (proxy_id, type) VALUES (?, ?)`
);

// better-sqlite3 не биндит массив в IN (...) — по стейтменту на каждый вид.
const stmtLastUptimeAlert = db.prepare(
  `SELECT * FROM alerts WHERE proxy_id = ? AND type IN ('down', 'recovery')
   ORDER BY sent_at DESC, id DESC LIMIT 1`
);

const stmtLastRotationAlert = db.prepare(
  `SELECT * FROM alerts WHERE proxy_id = ? AND type IN ('stale_ip', 'rotation_ok')
   ORDER BY sent_at DESC, id DESC LIMIT 1`
);

// Ключ probe отделён от rotation, чтобы дедупликация stale_ip/rotation_ok не поехала.
const stmtLastProbeAlert = db.prepare(
  `SELECT * FROM alerts WHERE proxy_id = ? AND type IN ('ip_probe_down', 'ip_probe_ok')
   ORDER BY sent_at DESC, id DESC LIMIT 1`
);

export type AlertType =
  | "down"
  | "recovery"
  | "stale_ip"
  | "rotation_ok"
  | "ip_probe_down"
  | "ip_probe_ok";

export function saveAlert(proxyId: number, type: AlertType) {
  return stmtSaveAlert.run(proxyId, type);
}

export function getLastAlert(
  proxyId: number,
  kind: "uptime" | "rotation" | "probe"
): AlertRow | undefined {
  const stmt =
    kind === "uptime"
      ? stmtLastUptimeAlert
      : kind === "rotation"
        ? stmtLastRotationAlert
        : stmtLastProbeAlert;
  return stmt.get(proxyId) as AlertRow | undefined;
}

// --- System alerts ---
//
// Отдельная таблица, потому что в alerts обязателен proxy_id. Системные типы
// намеренно не входят в AlertType: иначе они попали бы в выборки uptime/rotation
// и сломали бы существующую дедупликацию.

const stmtSaveSystemAlert = db.prepare(
  `INSERT INTO system_alerts (type) VALUES (?)`
);

const stmtLastMassAlert = db.prepare(
  `SELECT * FROM system_alerts WHERE type IN ('mass_down', 'mass_recovery')
   ORDER BY sent_at DESC, id DESC LIMIT 1`
);

const stmtLastProbeSystemAlert = db.prepare(
  `SELECT * FROM system_alerts WHERE type IN ('ip_probe_system_down', 'ip_probe_system_ok')
   ORDER BY sent_at DESC, id DESC LIMIT 1`
);

export type SystemAlertType =
  | "mass_down"
  | "mass_recovery"
  | "ip_probe_system_down"
  | "ip_probe_system_ok";

export function saveSystemAlert(type: SystemAlertType) {
  return stmtSaveSystemAlert.run(type);
}

export function getLastSystemAlert(
  kind: "mass" | "ip_probe"
): SystemAlertRow | undefined {
  const stmt = kind === "mass" ? stmtLastMassAlert : stmtLastProbeSystemAlert;
  return stmt.get() as SystemAlertRow | undefined;
}

// --- Cleanup ---

const stmtCleanup = db.prepare(
  `DELETE FROM checks WHERE checked_at < datetime('now', ? || ' hours')`
);

export function deleteOldChecks(olderThanHours = 24) {
  return stmtCleanup.run(`-${olderThanHours}`);
}

export default db;
