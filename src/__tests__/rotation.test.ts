import { describe, it, expect } from "vitest";
import { nextIpState, isRotationStale, nextProbeFailure } from "../rotation.js";

const INTERVAL = 300_000; // 5 мин
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

describe("nextIpState", () => {
  it("treats the very first observation as a baseline, not a change", () => {
    const r = nextIpState(undefined, "1.2.3.4", T0, INTERVAL);
    expect(r.baseline).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.state).toEqual({ ip: "1.2.3.4", ipSince: T0, lastProbeAt: T0 });
  });

  it("records a change when the IP differs", () => {
    const prev = { ip: "1.2.3.4", ipSince: T0, lastProbeAt: T0 + INTERVAL };
    const r = nextIpState(prev, "5.6.7.8", T0 + 2 * INTERVAL, INTERVAL);
    expect(r.changed).toBe(true);
    expect(r.state.ipSince).toBe(T0 + 2 * INTERVAL);
  });

  it("keeps ipSince when the same IP is seen without a gap", () => {
    const prev = { ip: "1.2.3.4", ipSince: T0, lastProbeAt: T0 + INTERVAL };
    const r = nextIpState(prev, "1.2.3.4", T0 + 2 * INTERVAL, INTERVAL);
    expect(r.changed).toBe(false);
    expect(r.state.ipSince).toBe(T0);
    expect(r.state.lastProbeAt).toBe(T0 + 2 * INTERVAL);
  });

  it("restarts ipSince after a gap longer than two intervals", () => {
    const prev = { ip: "1.2.3.4", ipSince: T0, lastProbeAt: T0 + INTERVAL };
    const now = T0 + INTERVAL + 2 * INTERVAL + 1;
    const r = nextIpState(prev, "1.2.3.4", now, INTERVAL);
    expect(r.changed).toBe(false);
    expect(r.state.ipSince).toBe(now);
  });

  it("does not restart ipSince at exactly two intervals", () => {
    const prev = { ip: "1.2.3.4", ipSince: T0, lastProbeAt: T0 + INTERVAL };
    const now = T0 + INTERVAL + 2 * INTERVAL;
    const r = nextIpState(prev, "1.2.3.4", now, INTERVAL);
    expect(r.state.ipSince).toBe(T0);
  });
});

describe("isRotationStale", () => {
  it("is true once the observation is at least maxAge old", () => {
    expect(isRotationStale(T0, T0 + 2_700_000, 2_700_000)).toBe(true);
  });

  it("is false before the threshold", () => {
    expect(isRotationStale(T0, T0 + 2_699_999, 2_700_000)).toBe(false);
  });

  it("is always false when maxAge is 0", () => {
    expect(isRotationStale(T0, T0 + 99_999_999, 0)).toBe(false);
  });
});

describe("nextProbeFailure", () => {
  const T = Date.UTC(2026, 0, 1, 12, 0, 0);
  const INTERVAL_MS = 300_000;

  it("starts a series on the first failure", () => {
    expect(nextProbeFailure(undefined, T, INTERVAL_MS)).toEqual({
      fails: 1,
      since: T,
      lastFailedAt: T,
    });
  });

  it("counts consecutive failures within the observation window", () => {
    const prev = { fails: 1, since: T, lastFailedAt: T };
    expect(nextProbeFailure(prev, T + INTERVAL_MS, INTERVAL_MS)).toEqual({
      fails: 2,
      since: T,
      lastFailedAt: T + INTERVAL_MS,
    });
  });

  it("restarts the series after a gap longer than two intervals", () => {
    const prev = { fails: 2, since: T, lastFailedAt: T + INTERVAL_MS };
    const now = T + INTERVAL_MS + 2 * INTERVAL_MS + 1;
    expect(nextProbeFailure(prev, now, INTERVAL_MS)).toEqual({
      fails: 1,
      since: now,
      lastFailedAt: now,
    });
  });

  it("does not restart at exactly two intervals", () => {
    const prev = { fails: 2, since: T, lastFailedAt: T + INTERVAL_MS };
    const now = T + INTERVAL_MS + 2 * INTERVAL_MS;
    expect(nextProbeFailure(prev, now, INTERVAL_MS).fails).toBe(3);
  });
});
