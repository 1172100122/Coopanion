# Coopanion telemetry server

Receives the app's anonymous usage statistics. The client is `core/telemetry.ts`; every field is listed in [docs/TELEMETRY.md](../docs/TELEMETRY.md). One file (`server.mjs`), Node's built-in SQLite, no dependencies. Client IP addresses are used only for rate limiting in memory and are never stored.

## Run

```bash
mkdir -p data && chown 1000:1000 data
echo "STATS_TOKEN=$(openssl rand -hex 24)" > .env && chmod 600 .env
docker compose --env-file .env up -d --build
```

It listens on `127.0.0.1:8790`; put an HTTPS reverse proxy in front (the production one is Caddy on `survey.palailab.org`).

## Summary

```bash
curl -s -H "Authorization: Bearer $STATS_TOKEN" https://survey.palailab.org/v1/stats
```

Installs, installs active (with something done with Coo) in the last 1/7/30 days, new installs and daily actives per day, retention on day 1/7/30 by first date (both "did something" and "opened"), sources, versions, platforms, models and extensions. For anything else, query `data/telemetry.sqlite` directly: `installs`, `events` (one row per event, the raw event in `data`) and `days` (one row per install and local date, the raw record in `data`).
