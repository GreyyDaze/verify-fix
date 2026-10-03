# slots-booking — web app + browser, API and staged Multistep checks (one project)

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
checks/multistep-booking.check.ts  ONE MultiStepCheck construct
checks/multistep-booking.spec.ts   five-step transaction entrypoint (not auto-discovered as a construct)
app/api/v1/availability exact booking-availability JSON contract
checkly.config.ts       one project: Playwright suite + ApiCheck + Multistep, two regions
```

```bash
npm ci --ignore-scripts
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
`CHECKLY_API_KEY`, `TEST_USER`, and `API_TOKEN` in GitHub Secrets, and
`CHECKLY_ACCOUNT_ID` in GitHub Variables. Use the same `API_TOKEN` that Vercel
holds for the authenticated route. Optional regional users use
`TEST_USER_US_EAST_1` and `TEST_USER_EU_WEST_1`. The Vercel automation
bypass secret is environment-scoped; the staged protected production job
fails closed until it is configured and verified separately. GitHub environments separate preview
and production values, so the variable names do not need custom prefixes. This
repository's controlled proof may use the existing key. Use a restricted
preview key for arbitrary PRs when one is available. The Phase 7 protected
production job requires an **explicit** `VERIFY_FIX_BUNDLE` GitHub variable
selecting a reviewed, pinned real Multistep v3 incident; the historical
Phase 6 API bundle is not eligible.

The deployment adapter still calls its **old** immutable workflow snapshot.
The updated Phase 7 reusable gate in this branch is staged only; neither a
real Multistep proof nor a caller-pin update has occurred.
Require that gate's check names in the GitHub ruleset, and require owner review
for workflow changes through the repository's `CODEOWNERS` file. Its first job
has no protected secrets. It resolves the PR head, creates a complete immutable
snapshot, and performs static checks. The approved job then requires the
deployment SHA to equal that PR head. The pinned workflow runs a trusted
verifier and incident bundle outside files changed by the candidate. Fork PRs
remain blocked until the protected reviewer explicitly approves them. The
workflow creates its dotenv and deployment-metadata files under `$RUNNER_TEMP`;
no runtime value is committed. Only after the configured real bundle and bypass pass protected verification
would the production Checkly deploy receive the separate Multistep identities.

`playwright.config.ts` reads
`CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET` only when CI supplies it. It
sends that value through Vercel's automation header. Public previews need no
bypass value.

## Phase 6 API baseline on a Mac

_Status: complete and historical. The baseline, the incident, the repair, and
the protected preview and production proofs below have all been carried out.
This walkthrough is preserved as historical provenance: current main already
contains the `status` contract and the repaired check, so recreating the old
baseline requires the recorded historical revisions or a new controlled
incident. Do not run these commands blindly against current production, and do
not overwrite `incidents/slots-availability-api`._

Run these commands only from your Mac. Use the real production URL printed by
Vercel. Do not guess it. The commands keep secrets in the shell and in the two
providers.

```bash
cd /path/to/verify-fix/examples/slots-booking/web
npm ci
npx checkly login

export API_TOKEN="$(openssl rand -hex 32)"
export ENVIRONMENT_URL="https://your-real-vercel-production-url"

# Add the same route token to production, previews, and protected gate environments.
printf '%s' "$API_TOKEN" | npx vercel env add API_TOKEN production
printf '%s' "$API_TOKEN" | npx vercel env add API_TOKEN preview
printf '%s' "$API_TOKEN" | gh secret set API_TOKEN --env verify-fix-preview
printf '%s' "$API_TOKEN" | gh secret set API_TOKEN --env verify-fix-production
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
The baseline response — the historical contract the incident was built from —
is:

```json
{ "slot": "09:30", "availability": "AVAILABLE" }
```

The current contract after the completed Phase 6 repair is
`{ "slot": "09:30", "status": "AVAILABLE" }`.

The incident step (plan Phase 6) has been completed: it changed only the
application response field to `status` and did not deploy a matching check
change. After the scheduled check failed, obtain its real ID without copying
account data into the repo:

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

That gate has since passed for the Phase 6 repair: the protected preview proof
and the production proof (through the manually verified stable alias, after the
generated-URL attempt failed only on Vercel's HTTP 302 Deployment Protection)
both succeeded, and `checkly deploy` ran only after PASS. Those are
**Phase 6 historical proofs**, not evidence for Phase 7.

## Phase 7 checkpoint (local / synthetic only)

The app now returns a nested HTTP-200 booking object
`{ booking: { confirmed, status, account, slot, sessionVersion } }`. Its
one Multistep construct and five-step API-only script are checked in. The
original Multistep book-step assertion still reads flat `body.confirmed`;
do not silently repair it before the real scheduled incident is captured.
The script uses `ENVIRONMENT_URL` without a fallback and selects one account
per region from `MULTISTEP_USER_US_EAST_1` and `MULTISTEP_USER_EU_WEST_1`;
these are **not** the browser `TEST_USER*` variables. Neither regional
identity nor any real bypass value is included in this repo.

The staged secret-free production preflight accepts only the current `main`
deployment and **two** distinct successful HTTPS origins on that *same*
deployment: generated verification (Vercel App) and the human-verified stable
monitoring status with exact marker `verify-fix:stable-alias-verified`
(created with `auto_inactive: false`). The protected job verifies only the
generated origin via a trusted pinned verifier and deploys Checkly only to the
stable origin after PASS, Checkly preview and an immediate status recheck.
Until reviewer approval advances `.github/workflows/gate.yml`'s immutable
caller pin, the edited reusable workflow remains inactive. Missing bundle,
bypass, origin readiness or status provenance fails closed; no domain
exception, `VERCEL_TOKEN` or Vercel API route is assumed.

Locally, synthetic fixtures exercise the v3 parser, exact failure line,
bounded files/ZIP/network responses, single-field HTTP-200 mutation,
independent request/reporter audit and both regional identities. They cannot
stand in for real Checkly assets or a cloud/deployment PASS. The remaining
checkpoints are: inspect actual passing/failing Multistep assets outside this
repo, capture a sanitized bundle with the packed CLI, verify Checkly parity
with explicit `--record`, exact `--grep '^slots booking multistep transaction$'`,
`--retries 0` and **one** env input mechanism (`--env-file` or `--env`),
then obtain protected exact-revision PASS and later observe repaired scheduled
green in both regions. No real Phase 7 deploy, status registration or RCA
trigger was attempted here; Phase 8 stays blocked. See
[`../../../docs/PLAN.md`](../../../docs/PLAN.md) for the stage table.
