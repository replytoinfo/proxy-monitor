/** Порог «здоровой» прокси: ниже начинается жёлтая зона. */
const GOOD = 99;
/** Ниже этого прокси считается проблемной. */
const FAIR = 95;

export function qualityIcon(quality: number): string {
  if (quality >= GOOD) return "\u{1F7E2}";
  if (quality >= FAIR) return "\u{1F7E1}";
  return "\u{1F534}";
}

/**
 * Хвост для строки в /list. Потолок в 99% для всего, что не равно ровно сотне:
 * округление 99.94 до «100%» пряталo бы сбои за красивым числом, а смысл
 * показателя ровно в том, чтобы их показать.
 */
export function formatQualityTail(quality: number | undefined): string {
  if (quality === undefined) return "";
  const shown = quality === 100 ? 100 : Math.min(99, Math.round(quality));
  return ` · ${shown}%`;
}

/** Фактический охват данных: пока неделя не набралась, обещать неделю нельзя. */
export function formatWindow(hours: number): string {
  if (hours < 24) return `за ${hours} часов`;
  const days = Math.floor(hours / 24);
  const word = days === 1 ? "день" : days < 5 ? "дня" : "дней";
  return `за ${days} ${word}`;
}
