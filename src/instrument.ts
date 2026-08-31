import { readFileSync } from "node:fs";
import * as Sentry from "@sentry/node";

/**
 * Только отчёты об ошибках. Трейсинг не нужен, а его ESM-хуки
 * (import-in-the-middle) стоят десятки мегабайт на тесном сервере.
 * Отказы прокси сюда не идут — они штатный результат проверки и живут в базе.
 *
 * Стектрейсы разворачивает сам Node по флагу --enable-source-maps:
 * загрузка sourcemaps в Sentry и auth-токен для этого не нужны.
 *
 * Пустой SENTRY_DSN — SDK просто не поднимается.
 */
if (process.env.SENTRY_DSN) {
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string };

  Sentry.initWithoutDefaultIntegrations({
    dsn: process.env.SENTRY_DSN,
    integrations: Sentry.getDefaultIntegrationsWithoutPerformance(),
    registerEsmLoaderHooks: false,
    environment: process.env.NODE_ENV ?? "production",
    release: `proxy-monitor@${version}`,
  });
}
