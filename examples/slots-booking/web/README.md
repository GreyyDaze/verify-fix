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

## Protected gate setup

Create protected GitHub environments named `verify-fix-preview` and
`verify-fix-production`. Require an authorized reviewer for the preview
environment. In each environment, use Checkly's standard names:
`CHECKLY_API_KEY` and `TEST_USER` in GitHub Secrets, and
`CHECKLY_ACCOUNT_ID` in GitHub Variables. Optional regional users use
`TEST_USER_US_EAST_1` and `TEST_USER_EU_WEST_1`. The optional Vercel automation
bypass secret is also environment-scoped. GitHub environments separate preview
and production values, so the variable names do not need custom prefixes. This
repository's controlled proof may use the existing key. Use a restricted
preview key for arbitrary PRs when one is available. `VERIFY_FIX_BUNDLE` may
select a newer sanitized incident bundle.

The deployment adapter calls the protected reusable gate at an immutable commit.
Require that gate's check names in the GitHub ruleset, and require owner review
for workflow changes through the repository's `CODEOWNERS` file. Its first job
has no protected secrets. It resolves the PR head, creates a complete immutable
snapshot, and performs static checks. The approved job then requires the
deployment SHA to equal that PR head. The pinned workflow runs a trusted
verifier and incident bundle outside files changed by the candidate. Fork PRs
remain blocked until the protected reviewer explicitly approves them. The
workflow creates its dotenv and deployment-metadata files under `$RUNNER_TEMP`;
no runtime value is committed. The production deploy receives the same user
variables only after verification passes.

`playwright.config.ts` reads
`CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET` only when CI supplies it. It
sends that value through Vercel's automation header. Public previews need no
bypass value.
