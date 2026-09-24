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
checks/availability.*   authenticated ApiCheck and its setup entrypoint
app/api/v1/availability exact booking-availability JSON contract
checkly.config.ts       one project: Playwright suite + ApiCheck, two regions
```

```bash
npm install
npm run build && npm run start   # http://localhost:3000
npm run collision                # proves the one-session-per-account rule
npx playwright install chromium && ENVIRONMENT_URL=http://localhost:3000 CHECKLY_REGION=us-east-1 TEST_USER_US_EAST_1=demo npx playwright test
npx checkly login && npm run checkly:test     # ad-hoc run on Checkly's cloud (never touches scheduled monitors)
npm run checkly:deploy                        # create/update the scheduled check
```

App env vars (names only — see `.env.example`):
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` /
`KV_REST_API_TOKEN`) for the shared session store, `SLOT_LOAD_DELAY_MS` for the
race window (default 1500), and `API_TOKEN` for the authenticated availability
route. `API_TOKEN` is required for the API example. Checkly credentials come
from `npx checkly login` or `CHECKLY_API_KEY` + `CHECKLY_ACCOUNT_ID` in your
shell. Never write these values into this folder.

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

## Phase 6 API baseline on a Mac

Run these commands only from your Mac. Use the real production URL printed by
Vercel. Do not guess it. The commands keep secrets in the shell and in the two
providers.

```bash
cd /path/to/verify-fix/examples/slots-booking/web
npm ci
npx checkly login

export API_TOKEN="$(openssl rand -hex 32)"
export ENVIRONMENT_URL="https://your-real-vercel-production-url"

# Add the same route token to the existing Vercel project.
printf '%s' "$API_TOKEN" | npx vercel env add API_TOKEN production
npx vercel --prod

# First prove the ApiCheck against production without changing scheduled checks.
CHECKLY_NO_DOTENV=1 npx checkly test \
  --no-record \
  --location us-east-1 \
  --grep '^slots availability API$'

# Review the deployment plan. Then deploy both checks in this one Checkly project.
CHECKLY_NO_DOTENV=1 npx checkly deploy --preview
CHECKLY_NO_DOTENV=1 npx checkly deploy --force
```

Stop here until `slots availability API` has real passing history in Checkly.
The baseline response is:

```json
{ "slot": "09:30", "availability": "AVAILABLE" }
```

The incident step comes later. It changes only the application response field
to `status`. It does not deploy a matching check change. After the scheduled
check fails, obtain its real ID without copying account data into the repo:

```bash
export CHECK_ID="$(npx checkly api /v1/checks | jq -r '.[] | select(.name == "slots availability API") | .id')"
test -n "$CHECK_ID"
```

From the repository root, build the trusted package and let its CLI create the
bundle. The command below records result history, sanitized API evidence, setup
provenance, asset hashes, and the available RCA. It never writes `API_TOKEN`.

```bash
cd /path/to/verify-fix
npm ci
npm run build
export VERIFY_FIX_TGZ="$(npm pack --json | jq -r '.[0].filename')"
npm exec --yes --package="$PWD/$VERIFY_FIX_TGZ" -- verify-fix bundle \
  --check "$CHECK_ID" \
  --project "$PWD/examples/slots-booking/web" \
  --out "$PWD/incidents/slots-availability-api" \
  --measure 20 \
  --target "$ENVIRONMENT_URL" \
  --trigger-rca
```

Rocky Automatic Repair must remain off. Do not commit a bundle until its secret
scan and golden test pass. Do not run `checkly deploy` for the repair until the
exact-revision verify-fix gate passes.
