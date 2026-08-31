import * as Sentry from "@sentry/node";

/**
 * Только отчёты об ошибках. Трейсинг не нужен, а его ESM-хуки
 * (import-in-the-middle) стоят десятки мегабайт на тесном сервере.
 * Отказы прокси сюда не идут — они штатный результат проверки и живут в базе.
 *
 * Пустой SENTRY_DSN — SDK просто не поднимается.
 */
if (process.env.SENTRY_DSN) {
  Sentry.initWithoutDefaultIntegrations({
    dsn: process.env.SENTRY_DSN,
    integrations: Sentry.getDefaultIntegrationsWithoutPerformance(),
    registerEsmLoaderHooks: false,
    environment: process.env.NODE_ENV ?? "production",
  });
}
