# slots-booking — web app

Deployed to Vercel with **Root Directory** = `examples/slots-booking/web`.
Full description, API table and setup steps: [`../README.md`](../README.md).

```bash
npm install
npm run build && npm run start   # http://localhost:3000
npm run collision                # proves the one-session-per-account rule
```

Env vars (all optional, names only — see `.env.example`):
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` /
`KV_REST_API_TOKEN`) for the shared session store, `SLOT_LOAD_DELAY_MS` for the
race window (default 1500).
