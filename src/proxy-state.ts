/**
 * In-memory состояние, которое нужно и monitor.ts и telegram.ts.
 * Отдельный модуль разрывает цикл monitor ↔ telegram.
 */

export const _downSinceForTest = new Map<number, number>();

/** Когда прокси впервые ушла в down (timestamp). */
export const downSince: Map<number, number> = _downSinceForTest;

/** Сбросить все in-memory счётчики для прокси после /edit. */
export function forgetProxyState(id: number): void {
  downSince.delete(id);
}
