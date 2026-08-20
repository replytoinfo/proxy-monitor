**English** · [Русский](README.ru.md)

# proxy-monitor

Monitoring for HTTP and SOCKS5 proxies, managed and alerted through Telegram. Runs 24/7 and spends under a kilobyte of traffic per check.

## What it does

- **Checks liveness.** Opens a real connection through the proxy and issues a `HEAD` request. A handshake proves nothing: a proxy that accepts your login but won't pass traffic must count as dead.
- **Confirms failure with a backup target.** A proxy is marked `down` only after both the primary and the fallback address fail. The defaults are Cloudflare and Google, so a simultaneous outage is unlikely. The fallback check runs only after the primary fails, which keeps healthy proxies free of extra traffic.
- **Watches IP rotation.** For mobile proxies: if the external IP hasn't changed within `ROTATION_MAX_AGE`, an alert goes out. Several echo services are tried in order until one answers.
- **Reports its own failures.** A failed IP probe raises its own alert instead of silence. An external watchdog (healthchecks.io) confirms the process is alive.
- **Collapses alert storms.** When every proxy goes down at once, one message goes out instead of N.

## Telegram bot

| Command | Action |
|---------|--------|
| `/add` | add a proxy (`host:port:user:pass` or a URL) |
| `/list` | list proxies with their state |
| `/status` | monitoring summary |
| `/ip` | current external IPs and rotation age |
| `/label`, `/group` | set a label or group |
| `/pause`, `/resume` | suspend or resume checks |
| `/del` | remove a proxy |

## Security

Proxy passwords are stored encrypted (AES-256-GCM, key in `ENCRYPTION_KEY`). Passwords never reach error text, and `HEALTHCHECK_URL` is never logged because it carries a secret. Target addresses go through `net-policy.ts`: requests into private ranges are blocked unless `ALLOW_PRIVATE_TARGETS` says otherwise.

## Stack

TypeScript (ESM, NodeNext) · Node ≥20 · pnpm · better-sqlite3 · `socks` · vitest

Two production dependencies: `better-sqlite3` and `socks`. Everything else is the Node standard library.

## Running it

```bash
pnpm install
cp .env.example .env    # fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ENCRYPTION_KEY
pnpm build
pnpm start
```

Generate the encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Docker:

```bash
docker build -t proxy-monitor .
docker run -d --env-file .env -v $(pwd)/data:/app/data proxy-monitor
```

The SQLite database lives in `data/`. Mount that volume, otherwise check history disappears on restart.

## Development

```bash
pnpm dev     # tsx watch
pnpm test    # vitest
pnpm build   # tsc
pnpm audit --prod
```

Tests never touch the real network and never depend on wall-clock time: they start local servers on port `0` and drain the microtask queue by hand.

## Docs

- [docs/CHANGELOG.md](docs/CHANGELOG.md): change history
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): known issues and fixes

Both are written in Russian.

## License

MIT. See [LICENSE](LICENSE).
