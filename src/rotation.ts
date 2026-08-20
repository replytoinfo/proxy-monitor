export interface IpObservation {
  ip: string;
  /** Начало текущего непрерывного наблюдения этого IP. */
  ipSince: number;
  /** Время последнего успешного опроса. */
  lastProbeAt: number;
}

export interface IpStateTransition {
  state: IpObservation;
  /** IP действительно сменился — событие для журнала. */
  changed: boolean;
  /** Первое наблюдение за прокси — не смена, в журнал не пишется. */
  baseline: boolean;
}

/**
 * Разрыв больше двух циклов опроса означает, что наблюдение прерывалось
 * (прокси лежал, стоял на паузе или процесс перезапускался) — отсчёт
 * возраста IP начинается заново, но событием смены это не считается.
 */
export function nextIpState(
  prev: IpObservation | undefined,
  ip: string,
  now: number,
  probeInterval: number
): IpStateTransition {
  if (!prev) {
    return {
      state: { ip, ipSince: now, lastProbeAt: now },
      changed: false,
      baseline: true,
    };
  }

  if (prev.ip !== ip) {
    return {
      state: { ip, ipSince: now, lastProbeAt: now },
      changed: true,
      baseline: false,
    };
  }

  const interrupted = now - prev.lastProbeAt > 2 * probeInterval;
  return {
    state: {
      ip,
      ipSince: interrupted ? now : prev.ipSince,
      lastProbeAt: now,
    },
    changed: false,
    baseline: false,
  };
}

export interface ProbeFailureState {
  /** Сколько провалов подряд в текущей непрерывной серии. */
  fails: number;
  /** Начало серии. */
  since: number;
  lastFailedAt: number;
}

/**
 * Правило то же, что и у наблюдения за IP: разрыв больше двух циклов опроса
 * означает, что наблюдение прерывалось (прокси была отключена или процесс
 * не работал), и серия начинается заново. Иначе алерт склеился бы из
 * отказов, между которыми никто ничего не наблюдал.
 */
export function nextProbeFailure(
  prev: ProbeFailureState | undefined,
  now: number,
  probeInterval: number
): ProbeFailureState {
  if (!prev || now - prev.lastFailedAt > 2 * probeInterval) {
    return { fails: 1, since: now, lastFailedAt: now };
  }
  return { fails: prev.fails + 1, since: prev.since, lastFailedAt: now };
}

export function isRotationStale(
  ipSince: number,
  now: number,
  maxAge: number
): boolean {
  if (maxAge <= 0) return false;
  return now - ipSince >= maxAge;
}
