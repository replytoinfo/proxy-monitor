import { config } from "./config.js";
import {
  addProxy,
  updateProxyEndpoint,
  getProxies,
  deleteProxy,
  toggleProxy,
  setLabel,
  setGroup,
  getLastCheck,
  getConsecutiveFailCount,
  getIpState,
  countIpChanges,
  fromSqlTime,
  getQualityAll,
  decryptProxy,
  getChecksSpanHours,
  type ProxyRow,
} from "./db.js";
import { hasStrayCredentialText, parseProxyList, parseProxy } from "./parser.js";
import { qualityIcon, formatQualityTail, formatWindow } from "./quality-format.js";
import { measureSpeed, SPEED_DEADLINE_MS } from "./checker/speed.js";
import { selectSpeedTargets, isSpeedRunning, runSpeed } from "./speed-command.js";

const API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
const MAX_MESSAGE_TEXT = 4096;

let offset = 0;
let polling = false;

export { escapeHtml } from "./html.js";
import { escapeHtml } from "./html.js";

// --- Send messages ---

export async function sendMessage(
  text: string,
  chatId = config.TELEGRAM_CHAT_ID
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
        }),
      });

      if (res.ok) return true;

      const body = await res.text();
      console.error(`[telegram] API error ${res.status} (attempt ${attempt + 1})`);

      // Don't retry on client errors (except rate limit)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[telegram] Send failed (attempt ${attempt + 1}): ${msg}`);
    }

    // Backoff: 1s, 2s, 4s
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  return false;
}

// --- Alert formatters ---

function formatProxyLine(host: string, port: number, type: string, label?: string | null, groupName?: string | null): string[] {
  const lines: string[] = [];
  const meta: string[] = [];
  if (groupName) meta.push(`[${escapeHtml(groupName)}]`);
  if (label) meta.push(escapeHtml(label));
  if (meta.length > 0) lines.push(meta.join(" "));
  lines.push(`<code>${escapeHtml(host)}:${port}</code> (${escapeHtml(type.toUpperCase())})`);
  return lines;
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function formatDownAlert(
  host: string,
  port: number,
  type: string,
  label?: string | null,
  groupName?: string | null
): string {
  return [
    `\u{1F534} <b>Proxy DOWN</b>`,
    ...formatProxyLine(host, port, type, label, groupName),
    `Offline 3+ min`,
  ].join("\n");
}

export function formatReminderAlert(
  host: string,
  port: number,
  type: string,
  downtimeMs: number,
  label?: string | null,
  groupName?: string | null
): string {
  const duration = formatDuration(downtimeMs);

  return [
    `\u{1F7E0} <b>Still DOWN</b>`,
    ...formatProxyLine(host, port, type, label, groupName),
    `Offline ${duration}`,
  ].join("\n");
}

export function formatRecoveryAlert(
  host: string,
  port: number,
  type: string,
  downtimeMs: number,
  label?: string | null,
  groupName?: string | null
): string {
  const duration = formatDuration(downtimeMs);

  return [
    `\u{1F7E2} <b>Proxy RECOVERED</b>`,
    ...formatProxyLine(host, port, type, label, groupName),
    `Back online after ${duration}`,
  ].join("\n");
}

export function formatStaleIpAlert(
  host: string,
  port: number,
  type: string,
  ip: string,
  ageMs: number,
  label?: string | null,
  groupName?: string | null
): string {
  return [
    `\u{1F7E1} <b>IP rotation stalled</b>`,
    ...formatProxyLine(host, port, type, label, groupName),
    `Same IP <code>${escapeHtml(ip)}</code> for ${formatDuration(ageMs)}`,
  ].join("\n");
}

export function formatRotationOkAlert(
  host: string,
  port: number,
  type: string,
  ip: string,
  label?: string | null,
  groupName?: string | null
): string {
  return [
    `\u{1F7E2} <b>IP rotation resumed</b>`,
    ...formatProxyLine(host, port, type, label, groupName),
    `New IP <code>${escapeHtml(ip)}</code>`,
  ].join("\n");
}

export function formatIpProbeDownAlert(
  host: string,
  port: number,
  type: string,
  fails: number,
  lastError: string,
  label?: string | null,
  groupName?: string | null
): string {
  return [
    `\u{1F7E0} <b>IP probe failing</b>`,
    ...formatProxyLine(host, port, type, label, groupName),
    `${fails} consecutive failures — ${escapeHtml(lastError)}`,
  ].join("\n");
}

export function formatIpProbeOkAlert(
  host: string,
  port: number,
  type: string,
  ip: string,
  label?: string | null,
  groupName?: string | null
): string {
  return [
    `\u{1F7E2} <b>IP probe recovered</b>`,
    ...formatProxyLine(host, port, type, label, groupName),
    `External IP <code>${escapeHtml(ip)}</code>`,
  ].join("\n");
}

export function formatMassDownAlert(count: number): string {
  return [
    `\u{1F6A8} <b>All proxies DOWN</b>`,
    `${count} proxies unreachable in one cycle`,
    `Probable cause: monitor host or network, not the proxies`,
  ].join("\n");
}

export function formatMassRecoveryAlert(upCount: number, total: number): string {
  return [
    `\u{1F7E2} <b>Mass outage over</b>`,
    `${upCount} of ${total} proxies reachable again`,
  ].join("\n");
}

export function formatIpProbeSystemDownAlert(count: number): string {
  return [
    `\u{1F6A8} <b>IP probes failing everywhere</b>`,
    `${count} proxies could not report an external IP`,
    `Probable cause: echo services or monitor network`,
  ].join("\n");
}

export function formatIpProbeSystemOkAlert(okCount: number, total: number): string {
  return [
    `\u{1F7E2} <b>IP probes working again</b>`,
    `${okCount} of ${total} proxies reported an external IP`,
  ].join("\n");
}

// --- Command handlers ---

function formatProxyStatus(p: ProxyRow, quality?: number): string {
  const lastCheck = getLastCheck(p.id);
  const failCount = getConsecutiveFailCount(p.id, config.FAIL_THRESHOLD);

  let statusIcon: string;
  let statusText: string;

  if (!lastCheck) {
    statusIcon = "\u{26AA}";
    statusText = "pending";
  } else if (failCount >= config.FAIL_THRESHOLD) {
    statusIcon = "\u{1F534}";
    statusText = "DOWN";
  } else if (lastCheck.status === "up") {
    statusIcon = "\u{1F7E2}";
    statusText = `UP ${lastCheck.response_time}ms`;
  } else {
    statusIcon = "\u{1F7E1}";
    statusText = `fail (${failCount}/${config.FAIL_THRESHOLD})`;
  }

  const enabled = p.enabled ? "" : " [PAUSED]";
  const auth = p.username ? " \u{1F511}" : "";
  const safeHost = escapeHtml(p.host);
  const safeType = escapeHtml(p.type.toUpperCase());
  const labelStr = p.label ? ` ${escapeHtml(p.label)}` : "";

  return `${statusIcon} <b>#${p.id}</b>${labelStr} <code>${safeHost}:${p.port}</code> ${safeType}${auth}${enabled} — ${statusText}${formatQualityTail(quality)}`;
}

async function handleCommand(
  chatId: string,
  text: string
): Promise<void> {
  if (chatId !== config.TELEGRAM_CHAT_ID) return;

  // Truncate excessively long messages
  const trimmed = text.length > MAX_MESSAGE_TEXT
    ? text.slice(0, MAX_MESSAGE_TEXT)
    : text.trim();

  if (trimmed === "/start" || trimmed === "/help") {
    await sendMessage(
      [
        "<b>Proxy Monitor</b>",
        "",
        "/add [группа] — добавить прокси",
        "/edit <i>id</i> — заменить адрес/доступы (история сохраняется)",
        "/list [группа] — список со статусами",
        "/ip [группа] — текущие IP и возраст",
        "/label <i>id имя</i> — псевдоним",
        "/group <i>id</i> [группа] — сменить группу",
        "/del <i>id</i> — удалить",
        "/pause <i>id</i> — пауза",
        "/resume <i>id</i> — продолжить",
        "/status — сводка",
        "/quality — качество за неделю",
        "/speed [id|группа] — замер скорости",
        "",
        "<i>Форматы: ip:port, socks5://ip:port, user:pass@ip:port</i>",
      ].join("\n"),
      chatId
    );
    return;
  }

  if (trimmed === "/list" || trimmed.startsWith("/list ")) {
    const groupFilter = trimmed.replace(/^\/list\s*/, "").trim() || null;

    let proxies = getProxies();
    if (groupFilter) {
      proxies = proxies.filter(
        (p) => p.group_name?.toLowerCase() === groupFilter.toLowerCase()
      );
    }

    if (proxies.length === 0) {
      const msg = groupFilter
        ? `Нет прокси в группе "${escapeHtml(groupFilter)}".`
        : "Нет прокси. Используй /add чтобы добавить.";
      await sendMessage(msg, chatId);
      return;
    }

    const quality = new Map(
      getQualityAll(config.CHECKS_RETENTION_HOURS).map((q) => [q.proxy_id, q.quality])
    );

    const groups = new Map<string, ProxyRow[]>();
    const ungrouped: ProxyRow[] = [];

    for (const p of proxies) {
      if (p.group_name) {
        const list = groups.get(p.group_name) ?? [];
        list.push(p);
        groups.set(p.group_name, list);
      } else {
        ungrouped.push(p);
      }
    }

    const lines: string[] = [];
    for (const [name, items] of groups) {
      lines.push(`\n\u{1F4C1} <b>${escapeHtml(name)}</b>`);
      for (const p of items) lines.push(formatProxyStatus(p, quality.get(p.id)));
    }
    if (ungrouped.length > 0) {
      if (groups.size > 0) lines.push(`\n\u{1F4C1} <b>Без группы</b>`);
      for (const p of ungrouped) lines.push(formatProxyStatus(p, quality.get(p.id)));
    }

    await sendMessage(lines.join("\n").trim(), chatId);
    return;
  }

  if (trimmed === "/ip" || trimmed.startsWith("/ip ")) {
    const groupFilter = trimmed.replace(/^\/ip\s*/, "").trim() || null;

    let proxies = getProxies();
    if (groupFilter) {
      proxies = proxies.filter(
        (p) => p.group_name?.toLowerCase() === groupFilter.toLowerCase()
      );
    }

    if (proxies.length === 0) {
      const msg = groupFilter
        ? `Нет прокси в группе "${escapeHtml(groupFilter)}".`
        : "Нет прокси. Используй /add чтобы добавить.";
      await sendMessage(msg, chatId);
      return;
    }

    const now = Date.now();
    const lines = proxies.map((p) => {
      const state = getIpState(p.id);
      const paused = p.enabled ? "" : " [PAUSED]";
      const head = `<b>#${p.id}</b>${p.label ? ` ${escapeHtml(p.label)}` : ""}${paused}`;

      if (!state) return `${head} — нет данных`;

      const age = formatDuration(now - fromSqlTime(state.ip_since));
      const rotations = countIpChanges(p.id, 24);
      return `${head} <code>${escapeHtml(state.ip)}</code> — ${age}, смен за сутки: ${rotations}`;
    });

    await sendMessage(lines.join("\n"), chatId);
    return;
  }

  if (trimmed === "/status") {
    const proxies = getProxies();
    let online = 0;
    let offline = 0;
    let unknown = 0;
    let paused = 0;

    for (const p of proxies) {
      if (!p.enabled) {
        paused++;
        continue;
      }
      const lastCheck = getLastCheck(p.id);
      const failCount = getConsecutiveFailCount(p.id, config.FAIL_THRESHOLD);
      if (!lastCheck) unknown++;
      else if (failCount >= config.FAIL_THRESHOLD) offline++;
      else if (lastCheck.status === "up") online++;
      else unknown++;
    }

    await sendMessage(
      [
        `<b>Proxy Monitor</b>`,
        ``,
        `Total: ${proxies.length}`,
        `\u{1F7E2} Online: ${online}`,
        `\u{1F534} Offline: ${offline}`,
        `\u{26AA} Unknown: ${unknown}`,
        `\u{23F8} Paused: ${paused}`,
      ].join("\n"),
      chatId
    );
    return;
  }

  if (trimmed === "/quality") {
    const rows = getQualityAll(config.CHECKS_RETENTION_HOURS);

    if (rows.length === 0) {
      await sendMessage("Пока нет проверок — качество считать не из чего.", chatId);
      return;
    }

    const byId = new Map(getProxies().map((p) => [p.id, p]));
    const span = getChecksSpanHours(config.CHECKS_RETENTION_HOURS);
    const lines = [`<b>Качество ${formatWindow(span)}</b>`, ""];

    // Худшие сверху: показатель нужен, чтобы замечать проблемные, а не любоваться здоровыми.
    for (const q of [...rows].sort((a, b) => a.quality - b.quality)) {
      const p = byId.get(q.proxy_id);
      if (!p) continue;

      const name = p.label ?? p.group_name ?? `${p.host}:${p.port}`;
      const pct = q.quality === 100 ? "100" : Math.min(99, Math.round(q.quality));
      lines.push(
        `${qualityIcon(q.quality)} <b>#${p.id}</b> ${escapeHtml(name)} — ${pct}%`
      );

      const parts = [`${q.total} проверок`, `сбоев ${q.bad}`];
      // Разбивка нужна, только когда есть что разбивать: при нулевом fallback
      // она повторяла бы число сбоев ещё дважды.
      if (q.fallback > 0) parts.push(`DOWN ${q.down} · fallback ${q.fallback}`);
      if (q.medianMs !== null) parts.push(`медиана ${q.medianMs}ms`);
      lines.push(`   <i>${parts.join(" · ")}</i>`);
    }

    await sendMessage(lines.join("\n"), chatId);
    return;
  }

  if (trimmed === "/speed" || trimmed.startsWith("/speed ")) {
    const arg = trimmed.replace(/^\/speed\s*/, "");
    const { targets, error } = selectSpeedTargets(arg, getProxies());
    if (error) {
      await sendMessage(error, chatId);
      return;
    }
    if (targets.length === 0) {
      await sendMessage("Нет активных прокси. Используй /add чтобы добавить.", chatId);
      return;
    }
    if (isSpeedRunning()) {
      await sendMessage("Замер уже идёт — дождись результатов.", chatId);
      return;
    }

    const worstCase = Math.ceil((targets.length * SPEED_DEADLINE_MS) / 1000);
    await sendMessage(
      `Измеряю ${targets.length} прокси, это займёт до ${worstCase} с…`,
      chatId
    );

    // Фоном: getUpdates ждёт завершения обработчика, а прогон длится минуты.
    const url = new URL(config.SPEED_URL);
    void runSpeed(
      targets,
      (p) => measureSpeed(decryptProxy(p), url),
      (text) => sendMessage(text, chatId)
    ).catch((err) =>
      console.error("[speed] run failed:", err instanceof Error ? err.message : err)
    );
    return;
  }

  if (trimmed.startsWith("/add")) {
    const body = trimmed.replace(/^\/add\s*/, "");
    if (!body) {
      await sendMessage(
        "Отправь прокси после /add, по одному на строку:\n\n" +
          "<code>/add Mobile\n1.2.3.4:8080\nsocks5://5.6.7.8:1080</code>\n\n" +
          "С логином и паролем — через двоеточие:\n" +
          "<code>host:port:логин:пароль</code>\n\n" +
          "\u{1F4CC} Группа указывается <b>только первой строкой</b> сразу после /add " +
          "и не должна содержать двоеточий.\n\n" +
          "\u{26A0} Метку в конце строки прокси писать нельзя — она попадёт в пароль " +
          "и проверка будет падать с HTTP 407.",
        chatId
      );
      return;
    }

    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    let groupName: string | null = null;

    if (lines.length > 0 && !lines[0].includes(":") && !lines[0].includes("//")) {
      groupName = lines.shift()!;
    }

    const { valid, invalid } = parseProxyList(lines.join("\n"));
    const rejected = invalid.length
      ? "\n\n\u{26A0} Не распознано:\n" +
        invalid.map((l) => `<code>${escapeHtml(l)}</code>`).join("\n") +
        "\n\nФормат: <code>socks5://хост:порт:логин:пароль</code> — по одной прокси на строку, без подписей."
      : "";

    if (valid.length === 0) {
      await sendMessage(`Не найдено валидных прокси.${rejected}`, chatId);
      return;
    }

    for (const p of valid) {
      addProxy({ ...p, group_name: groupName ?? undefined });
    }

    const groupLabel = groupName ? ` \u{2192} ${escapeHtml(groupName)}` : "";
    const httpCount = valid.filter((p) => p.type === "http").length;
    // Тип по умолчанию — HTTP; молча добавленная HTTP-запись для SOCKS5-прокси даёт вечный fail.
    const typeHint = httpCount
      ? `\n\n\u{2139} Добавлено как HTTP: ${httpCount}. Если это SOCKS5 — удали (/del) и добавь с префиксом <code>socks5://</code>.`
      : "";

    // Прилипший к паролю хвост даёт вечный "Socks5 Authentication failed" —
    // без подсказки это видно только через 4 провала в алерте.
    const stray = valid.filter(hasStrayCredentialText);
    const strayHint = stray.length
      ? "\n\n\u{26A0} Пробел или скобки в логине/пароле:\n" +
        stray
          .map((p) => `<code>${escapeHtml(p.host)}:${p.port}</code>`)
          .join("\n") +
        "\n\nПохоже, из панели провайдера скопировался лишний текст. Проверь и добавь заново."
      : "";

    await sendMessage(
      `\u{2705} Добавлено: ${valid.length} прокси${groupLabel}${typeHint}${strayHint}${rejected}`,
      chatId
    );
    return;
  }

  if (trimmed.startsWith("/edit")) {
    // Формат: /edit <id>\n<строка прокси>
    const body = trimmed.replace(/^\/edit\s*/, "");
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const idStr = lines[0] ?? "";
    const proxyLine = lines[1] ?? "";

    const FORMAT_HINT =
      "Формат:\n<code>/edit id\nhost:port</code> или <code>socks5://user:pass@host:port</code>";

    if (!idStr.match(/^\d+$/) || !proxyLine) {
      await sendMessage(FORMAT_HINT, chatId);
      return;
    }

    const id = parseInt(idStr, 10);
    const parsed = parseProxy(proxyLine);
    if (!parsed) {
      await sendMessage(
        `Не удалось разобрать строку прокси.\n\n${FORMAT_HINT}`,
        chatId
      );
      return;
    }

    const result = updateProxyEndpoint(id, {
      host: parsed.host,
      port: parsed.port,
      type: parsed.type,
      username: parsed.username ?? null,
      password: parsed.password ?? null,
    });

    if (!result) {
      await sendMessage(`Прокси #${id} не найдена.`, chatId);
      return;
    }

    const { before, after } = result;
    const name = [after.group_name, after.label].filter(Boolean).join(" ") || String(after.id);
    const oldAddr = `${escapeHtml(before.host)}:${before.port}`;
    const newAddr = `${escapeHtml(after.host)}:${after.port}`;
    const typeInfo = after.type !== before.type ? ` (${escapeHtml(after.type)})` : "";
    const loginInfo = after.username ? `, логин ${escapeHtml(after.username)}` : "";

    await sendMessage(
      `\u{270F}\u{FE0F} #${id} ${escapeHtml(name)}: <code>${oldAddr}</code> \u{2192} <code>${newAddr}</code>${typeInfo}${loginInfo}`,
      chatId
    );
    return;
  }

  if (trimmed.startsWith("/label")) {
    const args = trimmed.replace(/^\/label\s*/, "");
    const match = args.match(/^(\d+)\s+(.+)/);
    if (!match) {
      await sendMessage("Формат: /label <i>id имя</i>", chatId);
      return;
    }
    const id = parseInt(match[1], 10);
    const label = match[2].trim();
    setLabel(id, label || null);
    await sendMessage(`\u{1F3F7} #${id} \u{2192} ${escapeHtml(label)}`, chatId);
    return;
  }

  if (trimmed.startsWith("/group")) {
    const args = trimmed.replace(/^\/group\s*/, "");
    const match = args.match(/^(\d+)(?:\s+(.+))?/);
    if (!match) {
      await sendMessage("Формат: /group <i>id</i> [группа]", chatId);
      return;
    }
    const id = parseInt(match[1], 10);
    const groupName = match[2]?.trim() || null;
    setGroup(id, groupName);
    const msg = groupName
      ? `\u{1F4C1} #${id} \u{2192} ${escapeHtml(groupName)}`
      : `\u{1F4C1} #${id} убран из группы`;
    await sendMessage(msg, chatId);
    return;
  }

  if (trimmed.startsWith("/del")) {
    const idStr = trimmed.replace(/^\/del\s*/, "");
    const id = parseInt(idStr, 10);
    if (!id || isNaN(id)) {
      await sendMessage("Укажи ID: /del <i>id</i>", chatId);
      return;
    }
    deleteProxy(id);
    await sendMessage(`\u{1F5D1} Прокси #${id} удалён`, chatId);
    return;
  }

  if (trimmed.startsWith("/pause")) {
    const idStr = trimmed.replace(/^\/pause\s*/, "");
    const id = parseInt(idStr, 10);
    if (!id || isNaN(id)) {
      await sendMessage("Укажи ID: /pause <i>id</i>", chatId);
      return;
    }
    toggleProxy(id, false);
    await sendMessage(`\u{23F8} Прокси #${id} приостановлен`, chatId);
    return;
  }

  if (trimmed.startsWith("/resume")) {
    const idStr = trimmed.replace(/^\/resume\s*/, "");
    const id = parseInt(idStr, 10);
    if (!id || isNaN(id)) {
      await sendMessage("Укажи ID: /resume <i>id</i>", chatId);
      return;
    }
    toggleProxy(id, true);
    await sendMessage(`\u{25B6}\u{FE0F} Прокси #${id} возобновлён`, chatId);
    return;
  }
}

// --- Long polling ---

// # Пауза после неудачного опроса. Цикл в startPolling вызывает getUpdates
// # вплотную, и мгновенный возврат при ошибке превращает разовый сбой Telegram
// # в флуд: 502 набирает сотни запросов в секунду, Telegram отвечает 429,
// # а 429 — это тоже !res.ok, то есть снова мгновенный возврат. Замер на боевом
// # логе за 39 суток: 2237 записей 502 и 403 записи 429, где 429 не причина,
// # а следствие. При успешном опросе паузы нет и не нужно: запрос сам висит
// # 30 секунд (timeout=30).
const POLL_BACKOFF_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getUpdates(): Promise<void> {
  try {
    const res = await fetch(
      `${API}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`,
      { signal: AbortSignal.timeout(35_000) }
    );

    if (!res.ok) {
      console.error(`[telegram] getUpdates error: ${res.status}`);
      // # При 429 срок называет сам Telegram — свой выдумывать незачем
      const retryAfter =
        res.status === 429
          ? ((await res.json().catch(() => null)) as
              | { parameters?: { retry_after?: number } }
              | null
            )?.parameters?.retry_after
          : null;
      await sleep(retryAfter ? retryAfter * 1000 : POLL_BACKOFF_MS);
      return;
    }

    const data = (await res.json()) as {
      ok: boolean;
      result: Array<{
        update_id: number;
        message?: { chat: { id: number }; text?: string };
      }>;
    };

    if (!data.ok || !data.result.length) return;

    for (const update of data.result) {
      offset = update.update_id + 1;

      if (update.message?.text) {
        const chatId = String(update.message.chat.id);
        await handleCommand(chatId, update.message.text);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name !== "TimeoutError") {
      console.error("[telegram] Polling error:", err.message);
      // # Та же ловушка, что и у HTTP-ошибки: без паузы обрыв сети уводит цикл
      // # в тесный retry. TimeoutError сюда не попадает намеренно — это штатное
      // # завершение long polling, после него нужен немедленный новый запрос
      await sleep(POLL_BACKOFF_MS);
    }
  }
}

async function setBotCommands() {
  const commands = [
    { command: "list", description: "Список прокси со статусами" },
    { command: "ip", description: "Текущие IP и ротация" },
    { command: "status", description: "Сводка" },
    { command: "quality", description: "Качество за неделю" },
    { command: "speed", description: "Замер скорости скачивания" },
    { command: "add", description: "Добавить прокси [в группу]" },
    { command: "edit", description: "Заменить адрес/доступы прокси" },
    { command: "label", description: "Псевдоним для прокси" },
    { command: "group", description: "Сменить группу прокси" },
    { command: "del", description: "Удалить прокси по ID" },
    { command: "pause", description: "Приостановить мониторинг" },
    { command: "resume", description: "Возобновить мониторинг" },
    { command: "help", description: "Помощь" },
  ];

  try {
    const res = await fetch(`${API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    if (res.ok) {
      console.log("[telegram] Bot commands registered");
    } else {
      console.error(`[telegram] setMyCommands error: ${res.status}`);
    }
  } catch (err) {
    console.error("[telegram] setMyCommands failed:", err instanceof Error ? err.message : err);
  }
}

export function startPolling() {
  polling = true;
  console.log("[telegram] Bot polling started");

  setBotCommands();

  const loop = async () => {
    while (polling) {
      await getUpdates();
    }
  };
  loop();
}

export function stopPolling() {
  polling = false;
  console.log("[telegram] Bot polling stopped");
}
