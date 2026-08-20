import * as dns from "node:dns/promises";
import { config } from "./config.js";

/**
 * Check if an IPv4 address falls within blocked ranges.
 * Blocks: loopback, private, link-local, multicast, unspecified.
 */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255))
    return false;

  const [a, b] = parts;

  // 0.0.0.0 (unspecified)
  if (parts.every((p) => p === 0)) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (private)
  if (a === 10) return true;
  // 172.16.0.0/12 (private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local, includes metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 224.0.0.0/4 (multicast)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (reserved)
  if (a >= 240) return true;

  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // ::1 (loopback)
  if (normalized === "::1") return true;
  // :: (unspecified)
  if (normalized === "::") return true;
  // fe80::/10 (link-local)
  if (normalized.startsWith("fe80:")) return true;
  // fc00::/7 (unique local)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  // ff00::/8 (multicast)
  if (normalized.startsWith("ff")) return true;

  return false;
}

/**
 * Check if a raw IP string is blocked.
 */
function isBlockedIP(ip: string): boolean {
  if (ip.includes(":")) return isBlockedIPv6(ip);
  return isBlockedIPv4(ip);
}

/**
 * Validate that a proxy host is safe to connect to.
 * Resolves DNS and checks all resulting IPs.
 *
 * Returns null if safe, or an error string if blocked.
 */
export async function validateHost(host: string): Promise<string | null> {
  if (config.ALLOW_PRIVATE_TARGETS) return null;

  // Direct IP check
  if (isBlockedIP(host)) {
    return `Blocked: ${host} is a private/reserved address`;
  }

  // DNS resolution check — resolve hostname and validate all IPs
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(":")) {
    try {
      const results = await dns.lookup(host, { all: true });
      for (const result of results) {
        if (isBlockedIP(result.address)) {
          return `Blocked: ${host} resolves to private address ${result.address}`;
        }
      }
    } catch {
      // DNS resolution failed — let the checker handle the connection error
      return null;
    }
  }

  return null;
}
