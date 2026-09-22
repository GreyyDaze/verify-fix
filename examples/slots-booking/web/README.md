# slots-booking — web app + its Checkly check (one project)

Deployed to Vercel with **Root Directory** = `examples/slots-booking/web`.
Full description, API table and setup steps: [`../README.md`](../README.md).

```
app/, lib/              Next.js app
playwright.config.ts    standard Playwright config (ENVIRONMENT_URL → baseURL, trace: 'on')
tests/booking.spec.ts   the Playwright test that Checkly runs as the check
checkly.config.ts       Playwright Check Suite: 5 min, us-east-1 + eu-west-1, runParallel, TEST_USER
```

```bash
npm install
npm run build && npm run start   # http://localhost:3000
npm run collision                # proves the one-session-per-account rule
npx playwright install chromium && ENVIRONMENT_URL=http://localhost:3000 TEST_USER=demo npx playwright test
npx checkly login && npm run checkly:test     # ad-hoc run on Checkly's cloud (never touches scheduled monitors)
npm run checkly:deploy                        # create/update the scheduled check
```

Env vars (all optional, names only — see `.env.example`):
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` /
`KV_REST_API_TOKEN`) for the shared session store, `SLOT_LOAD_DELAY_MS` for the
race window (default 1500). Checkly credentials come from `npx checkly login`
or `CHECKLY_API_KEY` + `CHECKLY_ACCOUNT_ID` in your shell — never from a file
in this folder.

`checkly.config.ts` sets `bundle.packages.prune: { dependencies: true }` so
Checkly's runners install only the dev side of this `package.json`
(`@playwright/test`, `checkly`), not Next.js. Files on disk are untouched.
