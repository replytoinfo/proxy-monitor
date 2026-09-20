/**
 * Форматирует фактический охват данных для подписи медианы.
 * ≥ 24 ч → «Nд» (округление вниз), 1 ч ≤ x < 24 ч → «Nч» (округление вниз), < 1 ч → «<1ч».
 */
export function formatSpanLabel(hours: number): string {
  if (hours >= 24) return `${Math.floor(hours / 24)}д`;
  if (hours < 1) return "<1ч";
  return `${Math.floor(hours)}ч`;
}

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
