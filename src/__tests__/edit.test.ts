import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { forgetProxyState, _downSinceForTest } from "../proxy-state.js";

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
    ENCRYPTION_KEY: "a".repeat(64),
    IP_CHECK_INTERVAL: 300000,
    ROTATION_MAX_AGE: 2700000,
    IP_ECHO_URLS: ["http://api.ipify.org/"],
    CHECK_URL: "http://httpbin.org/status/200",
    CHECK_URL_FALLBACK: "http://www.gstatic.com/generate_204",
    IP_PROBE_FAIL_THRESHOLD: 3,
    HEALTHCHECK_URL: null,
    CHECKS_RETENTION_HOURS: 168,
  },
}));

const DB_FILE = join(tmpdir(), `pm-edit-test-${process.pid}.db`);
process.env.DB_PATH = DB_FILE;

let db: typeof import("../db.js");

beforeAll(async () => {
  db = await import("../db.js");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

describe("updateProxyEndpoint", () => {
  it("обновляет host/port/type/username, пароль шифруется", () => {
    const res = db.addProxy({
      host: "old.example.com",
      port: 1080,
      type: "http",
      username: "user1",
      password: "pass1",
      label: "MyLabel",
      group_name: "GroupA",
    });
    const id = Number(res.lastInsertRowid);

    const result = db.updateProxyEndpoint(id, {
      host: "new.example.com",
      port: 9090,
      type: "socks5",
      username: "user2",
      password: "pass2",
    });

    expect(result).not.toBeNull();
    const { before, after } = result!;

    // before содержит старые значения
    expect(before.host).toBe("old.example.com");
    expect(before.port).toBe(1080);
    expect(before.type).toBe("http");

    // host/port/type/username обновлены
    expect(after.host).toBe("new.example.com");
    expect(after.port).toBe(9090);
    expect(after.type).toBe("socks5");
    expect(after.username).toBe("user2");

    // пароль в базе зашифрован (не равен открытому тексту)
    expect(after.password).not.toBe("pass2");

    // после decryptProxy пароль совпадает с исходным
    const decrypted = db.decryptProxy(after);
    expect(decrypted.password).toBe("pass2");

    // group_name и label сохранились
    expect(after.group_name).toBe("GroupA");
    expect(after.label).toBe("MyLabel");

    // enabled не изменился
    expect(after.enabled).toBe(1);
  });

  it("история проверок (getQualityAll) сохраняется после обновления", () => {
    const res = db.addProxy({ host: "q.example.com", port: 3128, type: "http" });
    const id = Number(res.lastInsertRowid);

    // 3 проверки до обновления
    db.saveCheck(id, "up", 100, null, false);
    db.saveCheck(id, "up", 200, null, false);
    db.saveCheck(id, "down", null, "timeout", false);

    db.updateProxyEndpoint(id, {
      host: "q2.example.com",
      port: 3128,
      type: "http",
      username: null,
      password: null,
    });

    const qualityRows = db.getQualityAll(24);
    const row = qualityRows.find((r) => r.proxy_id === id);
    expect(row).toBeDefined();
    expect(row!.total).toBe(3);
  });

  it("состояние IP сбрасывается после обновления", () => {
    const res = db.addProxy({ host: "ip.example.com", port: 3128, type: "http" });
    const id = Number(res.lastInsertRowid);

    // добавляем состояние IP и счётчик сбоев
    db.upsertIpState(id, "1.2.3.4", "2026-09-01 00:00:00", "2026-09-01 00:00:00");
    db.upsertProbeFailure(id, 2, "2026-09-01 00:00:00", "2026-09-01 00:00:00", "error");

    db.updateProxyEndpoint(id, {
      host: "ip2.example.com",
      port: 3128,
      type: "http",
      username: null,
      password: null,
    });

    expect(db.getIpState(id)).toBeUndefined();
    expect(db.getProbeFailure(id)).toBeUndefined();
  });

  it("возвращает null для несуществующего id", () => {
    const result = db.updateProxyEndpoint(999999, {
      host: "no.example.com",
      port: 8080,
      type: "http",
      username: null,
      password: null,
    });
    expect(result).toBeNull();
  });

  it("username и password могут быть null", () => {
    const res = db.addProxy({
      host: "cred.example.com",
      port: 3128,
      type: "http",
      username: "u",
      password: "p",
    });
    const id = Number(res.lastInsertRowid);

    const result = db.updateProxyEndpoint(id, {
      host: "cred.example.com",
      port: 3128,
      type: "http",
      username: null,
      password: null,
    });

    expect(result).not.toBeNull();
    expect(result!.after.username).toBeNull();
    expect(result!.after.password).toBeNull();
  });

  it("вставляет маркер recovery если последний uptime-алерт — down", () => {
    const res = db.addProxy({ host: "alert.example.com", port: 3128, type: "http" });
    const id = Number(res.lastInsertRowid);
    db.saveAlert(id, "down");

    db.updateProxyEndpoint(id, {
      host: "alert2.example.com",
      port: 3128,
      type: "http",
      username: null,
      password: null,
    });

    const last = db.getLastAlert(id, "uptime");
    expect(last?.type).toBe("recovery");
  });

  it("не вставляет маркер recovery если последний uptime-алерт не down", () => {
    const res = db.addProxy({ host: "noalert.example.com", port: 3128, type: "http" });
    const id = Number(res.lastInsertRowid);
    // нет алертов вообще — не вставляем

    db.updateProxyEndpoint(id, {
      host: "noalert2.example.com",
      port: 3128,
      type: "http",
      username: null,
      password: null,
    });

    const last = db.getLastAlert(id, "uptime");
    expect(last).toBeUndefined();
  });

  it("forgetProxyState удаляет id из downSince", () => {
    _downSinceForTest.set(42, Date.now());
    expect(_downSinceForTest.has(42)).toBe(true);
    forgetProxyState(42);
    expect(_downSinceForTest.has(42)).toBe(false);
  });
});
