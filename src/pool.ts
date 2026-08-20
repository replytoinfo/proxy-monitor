export interface Semaphore {
  /** Занять слот. Возвращает функцию освобождения — вызывать ровно один раз. */
  acquire(): Promise<() => void>;
  /** Сколько слотов занято сейчас. */
  active(): number;
}

/**
 * Семафор с очередью FIFO. Один экземпляр — общий потолок исходящих
 * проверок для всех циклов сразу.
 */
export function createSemaphore(limit: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    };
  };

  return {
    acquire() {
      if (active < limit) {
        active += 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise<() => void>((resolve) => {
        waiters.push(() => {
          active += 1;
          resolve(makeRelease());
        });
      });
    },
    active() {
      return active;
    },
  };
}

/**
 * Выполнить задачу под слотом. Слот берётся ровно один раз на всю задачу —
 * включая запасные попытки и перебор адресов внутри неё. Вложенных
 * захватов быть не должно: при limit=1 они дадут взаимную блокировку.
 */
export async function withSlot<T>(sem: Semaphore, task: () => Promise<T>): Promise<T> {
  const release = await sem.acquire();
  try {
    return await task();
  } finally {
    release();
  }
}

export function runAllSettled<T>(
  sem: Semaphore,
  tasks: Array<() => Promise<T>>
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(tasks.map((task) => withSlot(sem, task)));
}
