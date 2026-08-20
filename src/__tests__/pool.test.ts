import { describe, it, expect } from "vitest";
import { createSemaphore, withSlot, runAllSettled } from "../pool.js";

/** Разогнать очередь микро- и макрозадач, не завися от реального времени. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createSemaphore", () => {
  it("never runs more tasks at once than the limit", async () => {
    const LIMIT = 2;
    const TASKS = 5;
    const sem = createSemaphore(LIMIT);

    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];

    const tasks = Array.from({ length: TASKS }, () => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
      return true;
    });

    const settled = runAllSettled(sem, tasks);

    await flush();
    expect(peak).toBe(LIMIT);
    expect(sem.active()).toBe(LIMIT);

    while (resolvers.length > 0) {
      resolvers.splice(0).forEach((resolve) => resolve());
      await flush();
    }

    const results = await settled;
    expect(results).toHaveLength(TASKS);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(peak).toBe(LIMIT);
    expect(sem.active()).toBe(0);
  });

  it("frees the slot when the task throws", async () => {
    const sem = createSemaphore(1);

    const results = await runAllSettled(sem, [
      async () => {
        throw new Error("boom");
      },
      async () => "second",
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1]).toEqual({ status: "fulfilled", value: "second" });
    expect(sem.active()).toBe(0);
  });

  it("shares one limit across two independent batches", async () => {
    const sem = createSemaphore(1);
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];

    const make = () => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
      return true;
    };

    const first = runAllSettled(sem, [make(), make()]);
    const second = runAllSettled(sem, [make(), make()]);

    await flush();
    expect(peak).toBe(1);

    while (resolvers.length > 0) {
      resolvers.splice(0).forEach((resolve) => resolve());
      await flush();
    }

    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });

  it("runs a task that awaits twice without deadlocking at limit 1", async () => {
    // Регрессия: слот берётся один раз на всю задачу. Вложенный захват
    // внутри задачи (например ради запасной попытки) заблокировал бы её сам об себя.
    const sem = createSemaphore(1);

    const result = await withSlot(sem, async () => {
      await Promise.resolve();
      await Promise.resolve();
      return "done";
    });

    expect(result).toBe("done");
    expect(sem.active()).toBe(0);
  });
});
