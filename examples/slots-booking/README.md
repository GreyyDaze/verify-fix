# slots-booking

A small slot-booking app with real Checkly checks (Playwright, API, Multistep),
used as the customer-side example for verify-fix.

## What it shows

- A Playwright Check Suite running from two regions with a shared account.
- An authenticated `ApiCheck` with a setup entrypoint.
- A five-step Multistep transaction.
- Real monitoring incidents: overlapping sessions, locator drift, API field
  rename, and a nested response change.
- Candidate repairs (good and bad) in `patches/`, used to exercise the CLI.

## Prerequisites

- Node.js 24+
- npm
- A Checkly account for cloud runs and deploys
- Vercel and Upstash only if you want to deploy the app

## Quick start

```bash
cd examples/slots-booking/web
npm ci --ignore-scripts
npm run build && npm run start      # http://localhost:3000
```

Prove the session rule without a browser:

```bash
npm run collision
```

Run the Playwright check against the local app:

```bash
npx playwright install chromium
ENVIRONMENT_URL=http://localhost:3000 TEST_USER=demo npx playwright test
```

## Project layout

```text
examples/slots-booking/
├── web/                             Next.js app + Checkly project
│   ├── app/, lib/                   application and session store
│   ├── playwright.config.ts
│   ├── tests/booking.spec.ts        Playwright check source
│   ├── checks/
│   │   ├── availability.check.ts    ApiCheck
│   │   ├── availability.setup.ts    API auth setup
│   │   ├── multistep-booking.check.ts
│   │   └── multistep-booking.spec.ts
│   └── checkly.config.ts            project + Playwright Check Suite
├── patches/                         candidate repairs
└── README.md
```

## Configuration

| Variable | Purpose | Required |
| --- | --- | --- |
| `ENVIRONMENT_URL` | Target deployment for every check | yes |
| `TEST_USER` | Local browser account (defaults to `demo`) | local only |
| `TEST_USER_US_EAST_1` | Browser account for `us-east-1` | Playwright check |
| `TEST_USER_EU_CENTRAL_1` | Browser account for `eu-central-1` | Playwright check |
| `API_TOKEN` | Bearer token for `/api/v1/availability` | API check |
| `MULTISTEP_USER_US_EAST_1` | Multistep account for `us-east-1` | Multistep |
| `MULTISTEP_USER_EU_CENTRAL_1` | Multistep account for `eu-central-1` | Multistep |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Protected preview access | protected preview |

Secret values live in the environment or Checkly; never commit them.

## The checks and incidents

| Check | Incident |
| --- | --- |
| `tests/booking.spec.ts` | Two regions log in as the same account; the slower run books with a superseded token and gets `401`. |
| `tests/booking.spec.ts` locator | App renames `data-testid="book-status"` to `booking-status`; the stale check fails. |
| `checks/availability.check.ts` | App renames the response field `availability` to `status`; the check still asserts the old field. |
| `checks/multistep-booking.spec.ts` | App moves the booking fields under `booking.*`; the check still reads the flat fields. |

## Patches

`patches/` holds candidate repairs grouped by incident:

```text
patches/
├── overlap/         browser session-overlap candidates
├── drift/           locator-drift candidates
├── api/             API field-rename candidates
├── multistep/       Multistep nested-response candidates
└── booking-check/   candidates for the booking DSL check
```

Each group contains at least one correct repair and several deliberately weak
ones (removed assertion, weakened operator, catch/ignore, hardcoded value,
retry or timeout masking). Feed them to the CLI with `--patch`.

## Capture and verify

Capture an incident (keep the bundle outside the repo, or under the ignored
`incidents/` directory):

```bash
./bin/verify-fix bundle \
  --check <checkId> \
  --project examples/slots-booking/web \
  --out "$HOME/.verify-fix/bundles/slots-booking" \
  --verbose
```

Verify a candidate against that bundle:

```bash
./bin/verify-fix verify \
  --patch examples/slots-booking/patches/api/01-good-field-rename \
  --bundle "$HOME/.verify-fix/bundles/slots-booking" \
  --executor scene
```

Exit codes: `0` PASS, `1` FAILED, `2` UNCERTAIN.

## Testing

```bash
# repository suite (no bundles, no live provider)
npm test

# typecheck
npm run typecheck

# example app and checks
cd examples/slots-booking/web
npm run typecheck
npm run build
```

Cloud runs and deploys are separate and need Checkly credentials:

```bash
npx checkly test -e ENVIRONMENT_URL=https://<deployment> --record
npx checkly deploy
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/api/health` says `"store":"memory"` | Upstash is not configured; overlapping logins will not collide. |
| `401 session superseded by a newer login` | Expected during the overlap incident. |
| Check fails at `book-status` | The locator was renamed; this is the drift incident. |
| API check expects `availability` | The app now returns `status`; this is the field-rename incident. |
| Multistep reads flat `body.confirmed` | The app now nests it under `booking.confirmed`. |
