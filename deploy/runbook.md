# HireAPI — one-VPS runbook

Single Docker host. SQLite on a named volume. Adapters stay on fixture HTML until you opt into live ATS.

## Env

Copy [`.env.example`](../.env.example) to `/etc/hireapi.env` (mode `600`). Set:

| Variable | Production |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | listen port (default `3000`) |
| `HIREAPI_DATABASE` | required; must sit on the volume, e.g. `/app/data/hireapi.sqlite` |
| `HIREAPI_BOOTSTRAP_KEY` | optional first `hk_live_...` when the keys table is empty |
| `HIREAPI_LIVE_ATS` | leave `0` (or unset) until soak |

Do not bake secrets into the image. Do not commit `.env`. A bind-mount over `/app/data` must be writable by uid `1000` (`node`).

## Build and run

```bash
docker build -t hireapi:local .
docker run -d --name hireapi --restart unless-stopped --init \
  --env-file /etc/hireapi.env \
  -p 127.0.0.1:3000:3000 \
  -v hireapi-data:/app/data \
  hireapi:local
```

The process listens on `0.0.0.0:$PORT` as the non-root `node` user (uid 1000). The data volume must be writable by that uid. Keep the published port on loopback and terminate TLS on Caddy or nginx.

## Health

`GET /healthz` → `200 {"ok":true}`. No auth.

```bash
curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz"
```

After bootstrap:

```bash
curl -fsS -H "Authorization: Bearer $HIREAPI_BOOTSTRAP_KEY" \
  "http://127.0.0.1:${PORT:-3000}/v1/me"
```

## Enable live ATS

1. Confirm `/healthz` is green with live off.
2. Set `HIREAPI_LIVE_ATS=1` in the env file (also `true` / `yes` / `on`).
3. Recreate the container. Only public Greenhouse, Ashby, and Lever hosts are fetched.
4. Transport failures are `upstream_blocked` (0 credits). LinkedIn and Indeed stay disabled.
5. Leave the flag unset in CI. `scripts/test.sh` fails if it is set.

Roll back: set `HIREAPI_LIVE_ATS=0` (or unset) and recreate. Do not run live ATS from CI.

Local soak (not CI): `bash scripts/live-smoke.sh`. See [docs/live-smoke.md](../docs/live-smoke.md).
