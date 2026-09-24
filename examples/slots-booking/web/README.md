# slots-booking — web app + its Checkly check (one project)

Deployed to Vercel with **Root Directory** = `examples/slots-booking/web`.
Full description, API table and setup steps: [`../README.md`](../README.md).

This folder is both an example and an integration-test fixture. It stays in
this repository, but it is excluded from the npm package. The package test
installs the packed CLI in a separate temporary customer project. The CLI only
receives a target URL and revision; Vercel is this example's deployment choice,
not a core dependency.

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

## Phase 5 gate setup

Create protected GitHub environments named `verify-fix-preview` and
`verify-fix-production`. Put `CHECKLY_API_KEY`, `TEST_USER`, optional regional
users, and the optional Vercel automation bypass secret in GitHub Secrets. Put
`CHECKLY_ACCOUNT_ID` in GitHub Variables. `VERIFY_FIX_BUNDLE` may select a
newer sanitized incident bundle. The workflow creates its dotenv file under
`$RUNNER_TEMP`; no runtime value is committed. The production deploy receives
the same user variables from the protected environment after verification
passes.

`playwright.config.ts` reads
`CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET` only when CI supplies it. It
sends that value through Vercel's automation header. Public previews need no
bypass value.
