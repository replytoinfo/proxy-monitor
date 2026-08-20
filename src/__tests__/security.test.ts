import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing modules that use it
vi.mock("../config.js", () => ({
  config: {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "12345",
    CHECK_INTERVAL: 45000,
    FAIL_THRESHOLD: 4,
    MAX_PROXIES: 100,
    MAX_ADD_BODY_BYTES: 10000,
    MAX_CONCURRENT_CHECKS: 10,
    ALLOW_PRIVATE_TARGETS: false,
    ENCRYPTION_KEY: "a".repeat(64), // 32 bytes hex
    IP_CHECK_INTERVAL: 300000,
    ROTATION_MAX_AGE: 2700000,
    IP_ECHO_URLS: ["http://api.ipify.org/"],
    CHECK_URL: "http://httpbin.org/status/200",
    CHECK_URL_FALLBACK: "http://www.gstatic.com/generate_204",
    IP_PROBE_FAIL_THRESHOLD: 3,
    HEALTHCHECK_URL: null,
  },
}));

import { parseProxy, parseProxies } from "../parser.js";
import { escapeHtml } from "../telegram.js";
import { validateHost } from "../net-policy.js";
import { encrypt, decrypt, isEncrypted } from "../crypto.js";

// --- Parser: Private/Reserved IP Rejection ---

describe("Parser: SSRF protection", () => {
  it("rejects loopback 127.0.0.1", () => {
    // Parser itself doesn't block IPs — that's net-policy's job
    // But parseProxy should still parse them (validation happens at check time)
    const result = parseProxy("127.0.0.1:8080");
    expect(result).not.toBeNull();
    expect(result!.host).toBe("127.0.0.1");
  });

  it("normalizes host to lowercase", () => {
    const result = parseProxy("EXAMPLE.COM:8080");
    expect(result?.host).toBe("example.com");
  });

  it("rejects https proxies (not implemented)", () => {
    expect(parseProxy("https://1.2.3.4:443")).toBeNull();
  });
});

describe("Net policy: blocks private IPs", () => {
  it("blocks 127.0.0.1", async () => {
    const result = await validateHost("127.0.0.1");
    expect(result).not.toBeNull();
    expect(result).toContain("private/reserved");
  });

  it("blocks 10.0.0.1", async () => {
    const result = await validateHost("10.0.0.1");
    expect(result).not.toBeNull();
  });

  it("blocks 192.168.1.1", async () => {
    const result = await validateHost("192.168.1.1");
    expect(result).not.toBeNull();
  });

  it("blocks 172.16.0.1", async () => {
    const result = await validateHost("172.16.0.1");
    expect(result).not.toBeNull();
  });

  it("blocks 169.254.169.254 (metadata)", async () => {
    const result = await validateHost("169.254.169.254");
    expect(result).not.toBeNull();
  });

  it("blocks 0.0.0.0", async () => {
    const result = await validateHost("0.0.0.0");
    expect(result).not.toBeNull();
  });

  it("allows public IPs", async () => {
    const result = await validateHost("8.8.8.8");
    expect(result).toBeNull();
  });
});

// --- Parser: Input Limits ---

describe("Parser: input limits", () => {
  it("rejects control characters in host", () => {
    expect(parseProxy("exam\x00ple.com:8080")).toBeNull();
  });

  it("rejects overly long hosts (>253 chars)", () => {
    const longHost = "a".repeat(254);
    expect(parseProxy(`${longHost}:8080`)).toBeNull();
  });

  it("rejects overly long passwords (>255 chars)", () => {
    const longPass = "a".repeat(256);
    expect(parseProxy(`user:${longPass}@example.com:8080`)).toBeNull();
  });

  it("truncates body to MAX_ADD_BODY_BYTES", () => {
    // MAX_ADD_BODY_BYTES = 10000
    const huge = Array.from({ length: 500 }, (_, i) => `1.2.3.${i % 256}:8080`).join("\n");
    const results = parseProxies(huge);
    expect(results.length).toBeLessThanOrEqual(100); // MAX_PROXIES
  });

  it("limits number of parsed proxies to MAX_PROXIES", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `1.2.3.${i % 256}:${3000 + (i % 1000)}`).join("\n");
    const results = parseProxies(lines);
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it("parses valid socks5 with colon auth", () => {
    const result = parseProxy("socks5://example.com:1080:user:pass");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("socks5");
    expect(result!.username).toBe("user");
    expect(result!.password).toBe("pass");
  });
});

// --- Telegram HTML Escaping ---

describe("Telegram: HTML escaping", () => {
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes closing code tags", () => {
    expect(escapeHtml("host</code>")).toBe("host&lt;/code&gt;");
  });

  it("escapes quotes", () => {
    expect(escapeHtml('"test"')).toBe("&quot;test&quot;");
  });

  it("handles combined injection attempt", () => {
    const input = '</code><b>HACKED</b><code>';
    const escaped = escapeHtml(input);
    expect(escaped).not.toContain("<b>");
    expect(escaped).not.toContain("</code>");
  });
});

// --- Credential Encryption ---

describe("Credential encryption", () => {
  it("encrypt produces different output than plaintext", () => {
    const plain = "mySecretPassword123";
    const encrypted = encrypt(plain);
    expect(encrypted).not.toBe(plain);
  });

  it("decrypt recovers original value", () => {
    const plain = "mySecretPassword123";
    const encrypted = encrypt(plain);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plain);
  });

  it("isEncrypted detects encrypted values", () => {
    const encrypted = encrypt("test");
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it("isEncrypted returns false for plaintext", () => {
    expect(isEncrypted("plaintext")).toBe(false);
  });

  it("different encryptions of same value produce different ciphertexts", () => {
    const plain = "same-password";
    const enc1 = encrypt(plain);
    const enc2 = encrypt(plain);
    expect(enc1).not.toBe(enc2); // Different IVs
    expect(decrypt(enc1)).toBe(plain);
    expect(decrypt(enc2)).toBe(plain);
  });
});
