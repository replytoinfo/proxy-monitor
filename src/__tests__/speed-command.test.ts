import { describe, it, expect } from "vitest";
import {
  selectSpeedTargets,
  formatSpeedReport,
  runSpeed,
  isSpeedRunning,
} from "../speed-command.js";
import type { SpeedResult } from "../checker/speed.js";
import type { ProxyRow } from "../db.js";

function makeProxy(overrides: Partial<ProxyRow> = {}): ProxyRow {
  return {
    id: 1,
    host: "proxy.example",
    port: 1080,
    type: "socks5",
    username: null,
    password: null,
    label: null,
    group_name: null,
    enabled: 1,
    created_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

const fleet = [
  makeProxy({ id: 1, label: "US-Better", group_name: "US" }),
  makeProxy({ id: 2, label: "USA4", group_name: "US", enabled: 0 }),
  makeProxy({ id: 3, label: "DE1", group_name: "DE" }),
];

describe("selectSpeedTargets", () => {
  it("returns only enabled proxies when no argument given", () => {
    const { targets } = selectSpeedTargets("", fleet);
    expect(targets.map((p) => p.id)).toEqual([1, 3]);
  });

  it("selects by id including a paused proxy", () => {
    const { targets } = selectSpeedTargets("2", fleet);
    expect(targets.map((p) => p.id)).toEqual([2]);
  });

  it("selects enabled proxies of a group case-insensitively", () => {
    const { targets } = selectSpeedTargets("us", fleet);
    expect(targets.map((p) => p.id)).toEqual([1]);
  });

  it("reports unknown id", () => {
    const { targets, error } = selectSpeedTargets("99", fleet);
    expect(targets).toEqual([]);
    expect(error).toContain("#99");
  });

  it("reports unknown group", () => {
    const { targets, error } = selectSpeedTargets("Asia", fleet);
    expect(targets).toEqual([]);
    expect(error).toContain("Asia");
  });
});

describe("formatSpeedReport", () => {
  const ok = (bytes: number, ms: number): SpeedResult => ({ bytes, ms, complete: true });

  it("formats a complete measurement with Mbit/s, size and seconds", () => {
    const text = formatSpeedReport([
      { proxy: fleet[0], result: ok(1_048_576, 2000) },
    ]);
    expect(text).toContain("#1");
    expect(text).toContain("US-Better");
    expect(text).toContain("4.2 Мбит/с");
    expect(text).toContain("1.0 МБ за 2.0 с");
  });

  it("marks a partial measurement as incomplete with approximate speed", () => {
    const text = formatSpeedReport([
      { proxy: fleet[2], result: { bytes: 262_144, ms: 30_000, complete: false } },
    ]);
    expect(text).toContain("≈0.1 Мбит/с");
    expect(text).toContain("не завершено");
  });

  it("escapes html in labels and errors", () => {
    const evil = makeProxy({ id: 7, label: "<b>x</b>" });
    const text = formatSpeedReport([
      { proxy: evil, result: { bytes: 0, ms: 0, complete: false, error: "boom <tag>" } },
    ]);
    expect(text).not.toContain("<b>x</b>");
    expect(text).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(text).toContain("boom &lt;tag&gt;");
  });

  it("survives zero ms without producing Infinity", () => {
    const text = formatSpeedReport([{ proxy: fleet[0], result: ok(1024, 0) }]);
    expect(text).not.toContain("Infinity");
  });
});

describe("runSpeed", () => {
  const result: SpeedResult = { bytes: 1, ms: 1, complete: true };

  it("measures sequentially and sends one report", async () => {
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const sent: string[] = [];

    const started = await runSpeed(
      [fleet[0], fleet[2]],
      async (p) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        order.push(p.id);
        inFlight--;
        return result;
      },
      async (text) => {
        sent.push(text);
      }
    );

    expect(started).toBe(true);
    expect(order).toEqual([1, 3]);
    expect(maxInFlight).toBe(1);
    expect(sent).toHaveLength(1);
    expect(isSpeedRunning()).toBe(false);
  });

  it("refuses a second run while the first is in progress", async () => {
    let calls = 0;
    const slow = runSpeed(
      [fleet[0]],
      async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return result;
      },
      async () => {}
    );

    const second = await runSpeed(
      [fleet[0]],
      async () => {
        calls++;
        return result;
      },
      async () => {}
    );

    expect(second).toBe(false);
    expect(await slow).toBe(true);
    expect(calls).toBe(1);
  });

  it("resets the running flag when send throws", async () => {
    await expect(
      runSpeed(
        [fleet[0]],
        async () => result,
        async () => {
          throw new Error("telegram down");
        }
      )
    ).rejects.toThrow("telegram down");
    expect(isSpeedRunning()).toBe(false);
  });
});
