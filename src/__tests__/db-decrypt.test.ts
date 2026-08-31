import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

vi.mock("../config.js", () => ({
  config: {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "12345",
    MAX_PROXIES: 100,
    CHECKS_RETENTION_HOURS: 168,
    ENCRYPTION_KEY: "a".repeat(64),
  },
}));

const DB_FILE = join(tmpdir(), `pm-decrypt-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");

beforeAll(async () => {
  db = await import("../db.js");
  db.addProxy({
    host: "proxy.example",
    port: 1080,
    type: "socks5",
    username: "user",
    password: "secret-pass",
  });
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(DB_FILE + suffix, { force: true });
  }
});

describe("decryptProxy", () => {
  it("returns the plaintext password for a row from getProxies", () => {
    const stored = db.getProxies()[0];
    // Ловушка, из-за которой /speed падал с Authentication failed:
    // getProxies отдаёт пароль в зашифрованном виде.
    expect(stored.password).not.toBe("secret-pass");

    const decrypted = db.decryptProxy(stored);
    expect(decrypted.password).toBe("secret-pass");
    expect(decrypted.host).toBe("proxy.example");
  });

  it("passes through a proxy without a password", () => {
    const row = { ...db.getProxies()[0], password: null };
    expect(db.decryptProxy(row).password).toBeNull();
  });
});
