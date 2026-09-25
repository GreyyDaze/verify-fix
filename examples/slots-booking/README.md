# Example 1 — slots-booking (browser + API checks)

A real, deployable app with real Checkly checks. This is the customer side of
the verify-fix story: verify-fix does not mutate the customer project — it
reads candidate source, monitoring configuration, imports, dependencies, and
recorded evidence.

```
examples/slots-booking/
├── web/                    ONE project, one package.json (Vercel "Root Directory")
│   ├── app/, lib/          Next.js app → deployed to Vercel (incl. the Phase 6 API route)
│   ├── playwright.config.ts
│   ├── tests/booking.spec.ts   the Playwright test that becomes the check
│   ├── checks/availability.check.ts  auto-discovered ApiCheck construct
│   ├── checks/availability.setup.ts  its setup entrypoint
│   └── checkly.config.ts   defines the Checkly project and Playwright suite → `npx checkly deploy`
└── README.md               this file
```

The check lives inside the app project, the layout Checkly's Playwright Check
Suite quickstart assumes ("an existing repository that already contains
Playwright tests"). The same Checkly project contains both checks:
`checkly.config.ts` defines the project and the Playwright suite, and Checkly
discovers the ApiCheck construct from `checks/availability.check.ts`, so a
single `npx checkly deploy` keeps the whole project in sync. Playwright Check
Suites install *your* `package.json` on
Checkly's runners, so `checkly.config.ts` sets
`bundle.packages.prune: { dependencies: true }`: the bundled copy of
`package.json` loses `next`, `react`, `@upstash/redis`, the shipped lockfile is
pruned to match, and the runner installs only the dev side
(`@playwright/test`, `checkly`). Files on disk are never modified. Verified
offline with the CLI's own bundler (`npx checkly debug parse-project`): the
tarball holds `package.json` (devDependencies only), a 237-package lockfile
without `next`/`react`, `playwright.config.ts`, `tests/booking.spec.ts`,
`tsconfig.json`.

## The app in one paragraph

Log in with an account name, get a session token, book a time slot. The app has
one deliberate rule: **one active session per account — the newest login wins.**
Every `POST /api/login` bumps the account's session version
(`acct:<user>:version`) and returns `tok-<user>-<version>`. `POST /api/book`
only accepts a token that carries the *current* version; anything older gets
`401 session superseded by a newer login`. Between login and booking, the
booking page loads availability (`GET /api/slots`, deliberately ~1.5 s). That
delay is the race window.

| Route | What it does |
| --- | --- |
| `GET /` | login page (label **Account**, button **Log in**) |
| `GET /book` | booking page (`login-status`, `session-version`, **Book 09:30**, `book-status`, `booking-result`) |
| `POST /api/login` | `{ account }` → `{ token, version }`, bumps the version |
| `GET /api/slots` | `{ slots }` after `SLOT_LOAD_DELAY_MS` (default 1500) |
| `POST /api/book` | Bearer token + `{ slot }` → `200 CONFIRMED` or `401` if superseded |
| `GET /api/v1/availability` | bearer `API_TOKEN` + `?slot=` → `{ slot, status }` (the Phase 6 API contract) |
| `GET /api/session` | diagnostic: token version vs current version |
| `GET /api/health` | `{ ok, store: "memory" \| "upstash" }` |

Sessions live in memory locally and in Upstash Redis on Vercel
(`lib/store.ts` picks automatically from env vars).

## The check in one paragraph

`web/tests/booking.spec.ts` is a normal Playwright test with four alarms:
login answered 200 → we are on `/book` → booking answered 200 → result reads
`CONFIRMED`. `web/checkly.config.ts` turns it into a **Playwright Check
Suite**: every 5 minutes, from `us-east-1` **and** `eu-west-1`, with
`runParallel: true` and one shared `TEST_USER=demo`.

## The incident this will produce (Phase 2 of the plan)

Two locations start at the same moment and both log in as `demo`. The second
login bumps the version. The first run is still waiting for slots, then books
with the old token → `401` → alarm 3 and 4 fail. Nothing is broken for real
users; the check is fighting itself. That is a very common real-world Checkly
incident, and it is the incident the tool must learn to bundle, replay and
judge fixes against.

## Phase 6 — the authenticated availability API (complete)

The same project now holds two checks: the browser suite above and one
**ApiCheck** (`web/checks/availability.check.ts`) on
`GET /api/v1/availability?slot=09:30`. The route requires a bearer token from
`API_TOKEN` — the value lives only in the environment (Vercel, GitHub
secrets/variables, your shell) and never in this repository — and answers
`{ "slot": "09:30", "status": "AVAILABLE" }`. The setup entrypoint
(`web/checks/availability.setup.ts`) attaches the `Authorization` and
`x-request-id` headers before every request.

Phase 6 is complete: the field-rename incident (`availability` → `status`,
app-only, check left stale) was captured with the packed CLI into
`incidents/slots-availability-api`, the strict repair was verified through the
protected preview and production proofs, and `checkly deploy` ran only after
PASS. The `status` contract above is current; `availability` was the
historical baseline the incident was built from. Commands, environment
preparation, and the gate procedure live in
[`web/README.md`](web/README.md) — this file does not repeat them.

Phase 7 will add exactly one Multistep booking-workflow check to this same
project; nothing else changes here until then.

## Run it locally

```bash
# app
cd examples/slots-booking/web
npm install
npm run build && npm run start          # http://localhost:3000
npm run collision                       # proves the rule at the API level (5 rows)

# check, against the local app (same folder, same node_modules)
npx playwright install chromium
ENVIRONMENT_URL=http://localhost:3000 TEST_USER=demo npx playwright test
```

`npm run collision` output on a healthy build:

```
PASS  healthy: login                       expected: 200            got: 200
PASS  healthy: book with own token         expected: 200 CONFIRMED  got: 200 CONFIRMED
PASS  overlap: B version = A version + 1   expected: 3              got: 3
PASS  overlap: A books after B logged in   expected: 401 ...        got: 401 session superseded by a newer login
PASS  overlap: B books                     expected: 200 CONFIRMED  got: 200 CONFIRMED
```

## One-time setup (needs your accounts — nothing here is automated on purpose)

### 1. Vercel

1. Vercel → **Add New Project** → import `GreyyDaze/verify-fix`.
2. **Root Directory** → `examples/slots-booking/web`. Framework: Next.js (auto).
3. Deploy. Note the production URL and put it in
   `web/playwright.config.ts` (`PRODUCTION_URL`).

`web/vercel.json` contains
`"ignoreCommand": "git diff --quiet HEAD^ HEAD -- :/examples/slots-booking/web"`,
so commits that only touch the tool (`src/`, `docs/`, …) do **not** trigger a
deploy. Caveat (Vercel's, not ours): it only compares the newest commit, so a
batch push whose last commit did not touch `web/` skips the build.

### 2. Upstash Redis (shared session store)

Vercel → project → **Storage** → **Upstash for Redis** → create. Vercel injects
`KV_REST_API_URL` / `KV_REST_API_TOKEN`; the app reads those (or
`UPSTASH_REDIS_REST_*` if you create the database on upstash.com). Redeploy once.
`GET /api/health` must then say `"store":"upstash"`. Without it every serverless
instance has its own memory and overlapping logins never collide.

### 3. Checkly

```bash
cd examples/slots-booking/web
npx checkly login                       # or export CHECKLY_API_KEY + CHECKLY_ACCOUNT_ID

# ad-hoc run on Checkly's cloud — session-only, never touches scheduled monitors
npx checkly test -e ENVIRONMENT_URL=https://<preview-or-prod>.vercel.app --record

# create/update the scheduled check from checkly.config.ts
npx checkly deploy
```

Then in the Checkly dashboard:

- confirm the check **slots booking flow** is green from both locations;
- enable **Rocky AI** automatic root-cause analysis for alerts (Settings → AI),
  so Phase 2 can read a real RCA with `npx checkly rca get <id> --output json`;
- optional: the Vercel integration, so previews are tested automatically.

Phase 0 is "done" when the check has been green on production for a few hours.

### 4. Capture with the tool (Phase 1)

```bash
cd <repo root>
(cd examples/slots-booking/web && npx checkly checks list)   # find the check id (or copy it from the dashboard URL)
./bin/verify-fix bundle --check <checkId> --out ./bundle --project examples/slots-booking/web --verbose
```

While the check is still green this produces a *baseline* bundle (status
`no-failure-yet`, one `healthy-live` scene). After the Phase 2 incident the same
command produces the full bundle: failing + passing HAR, Rocky RCA, three scenes.
Add `--measure 3 --measure-overlap 2` to also run the check on Checkly's cloud
(sequentially, then two copies at once) and record pass rates.

## What lives where (so the tool's later phases make sense)

| Thing | Comes from | Read by the tool in |
| --- | --- | --- |
| check source, locations, frequency, `runParallel`, env-var **names** | `web/checkly.config.ts` + `web/tests/booking.spec.ts` via `checkly deploy` | Phase 1 `verify-fix bundle` |
| failing / passing run traces (→ HAR) | Checkly check results + assets (`trace: 'on'`) | Phase 1 |
| root cause classification | Rocky RCA | Phase 1 (`REPRODUCTION` mode selection) |
| env var **values** (`TEST_USER`, credentials) | Checkly (encrypted) / your `.env` — never git | Phase 3 (`--env-file`) |

Alternative wiring, if a customer prefers classic Browser Checks: replace
`playwrightChecks` with `checks.browserChecks.testMatch: '**/*.spec.ts'` or an
explicit `new BrowserCheck(id, { code: { entrypoint: './tests/booking.spec.ts' } })`.
The tool treats both the same way.
