import { config } from "./config.js";

export interface ParsedProxy {
  host: string;
  port: number;
  type: "http" | "socks5";
  username?: string;
  password?: string;
}

const MAX_HOST_LEN = 253;
const MAX_CRED_LEN = 255;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const VALID_TYPES = new Set(["http", "socks5"]);
/** Домен или IPv4: буквы, цифры, точки и дефисы, без пробелов по краям и внутри. */
const VALID_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validateFields(
  host: string,
  port: number,
  type: string,
  username?: string,
  password?: string
): ParsedProxy | null {
  if (!host || host.length > MAX_HOST_LEN) return null;
  if (CONTROL_CHARS.test(host)) return null;
  if (!VALID_HOST.test(host)) return null;
  if (!isValidPort(port)) return null;
  if (!VALID_TYPES.has(type)) return null;
  if (username && (username.length > MAX_CRED_LEN || CONTROL_CHARS.test(username))) return null;
  if (password && (password.length > MAX_CRED_LEN || CONTROL_CHARS.test(password))) return null;

  const normalized: ParsedProxy = {
    host: host.toLowerCase(),
    port,
    type: type as ParsedProxy["type"],
  };
  if (username) normalized.username = username;
  if (password) normalized.password = password;
  return normalized;
}

/**
 * Parse a single proxy string into a structured object.
 *
 * Supported formats:
 *   ip:port
 *   ip:port:user:pass
 *   user:pass@ip:port
 *   http://ip:port
 *   socks5://ip:port
 *   socks5://ip:port:user:pass
 *   socks5://user:pass@ip:port
 *   http://user:pass@ip:port
 *
 * Note: https:// proxies are rejected (not yet implemented).
 */
export function parseProxy(line: string): ParsedProxy | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;

  // URL-style with colon auth: socks5://host:port:user:pass
  const urlColonAuth = trimmed.match(
    /^(https?|socks5):\/\/([^:]+):(\d+):([^:]+):(.+)$/i
  );
  if (urlColonAuth) {
    const [, scheme, host, portStr, user, pass] = urlColonAuth;
    const type = scheme.toLowerCase();
    if (type === "https") return null; // not supported yet
    return validateFields(host, parseInt(portStr, 10), type, user, pass);
  }

  // URL-style: socks5://user:pass@host:port or http://host:port
  const urlMatch = trimmed.match(
    /^(https?|socks5):\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/i
  );
  if (urlMatch) {
    const [, scheme, user, pass, host, portStr] = urlMatch;
    const type = scheme.toLowerCase();
    if (type === "https") return null; // not supported yet
    return validateFields(
      host,
      parseInt(portStr, 10),
      type,
      user,
      pass
    );
  }

  // user:pass@host:port (no scheme — defaults to HTTP)
  const atMatch = trimmed.match(/^([^:]+):([^@]+)@([^:]+):(\d+)$/);
  if (atMatch) {
    const [, user, pass, host, portStr] = atMatch;
    return validateFields(host, parseInt(portStr, 10), "http", user, pass);
  }

  // ip:port:user:pass
  const colonMatch = trimmed.match(/^([^:]+):(\d+):([^:]+):(.+)$/);
  if (colonMatch) {
    const [, host, portStr, user, pass] = colonMatch;
    return validateFields(host, parseInt(portStr, 10), "http", user, pass);
  }

  // ip:port (simplest)
  const simpleMatch = trimmed.match(/^([^:]+):(\d+)$/);
  if (simpleMatch) {
    const [, host, portStr] = simpleMatch;
    return validateFields(host, parseInt(portStr, 10), "http");
  }

  return null;
}

/**
 * Пробел или квадратные скобки в кредах — почти всегда хвост, прилипший при
 * копировании из панели провайдера (метка локации вида " [DE1]"). Пароль в
 * последней группе разбирается жадно, поэтому мусор из конца строки оседает
 * именно там. Формально такой пароль валиден — строку не отбраковываем,
 * только сигналим в /add.
 */
const STRAY_CRED_TEXT = /[\s[\]]/;

export function hasStrayCredentialText(proxy: ParsedProxy): boolean {
  return (
    STRAY_CRED_TEXT.test(proxy.username ?? "") ||
    STRAY_CRED_TEXT.test(proxy.password ?? "")
  );
}

export interface ParseReport {
  valid: ParsedProxy[];
  /** Непустые строки, которые не удалось разобрать — их показываем пользователю. */
  invalid: string[];
}

/**
 * Parse multiple proxy lines (newline-separated), keeping the lines that failed.
 * Enforces body size and line count limits.
 */
export function parseProxyList(text: string): ParseReport {
  if (text.length > config.MAX_ADD_BODY_BYTES) {
    text = text.slice(0, config.MAX_ADD_BODY_BYTES);
  }

  const valid: ParsedProxy[] = [];
  const invalid: string[] = [];

  for (const line of text.split(/\r?\n/).slice(0, config.MAX_PROXIES)) {
    const parsed = parseProxy(line);
    if (parsed) valid.push(parsed);
    else if (line.trim() && !line.trim().startsWith("#")) invalid.push(line.trim());
  }

  return { valid, invalid };
}

/**
 * Parse multiple proxy lines (newline-separated).
 * Enforces body size and line count limits.
 */
export function parseProxies(text: string): ParsedProxy[] {
  return parseProxyList(text).valid;
}
