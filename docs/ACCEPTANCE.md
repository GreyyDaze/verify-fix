# Real Provider Acceptance

`verify-fix` is tested against real Checkly infrastructure — not simulated. This document describes the acceptance commands, prerequisites, and evidence they produce.

---

## Purpose

Unit and integration tests use synthetic inputs. They prove the logic is internally consistent. Acceptance tests prove the tool works against the real Checkly API, real asset storage, real Multistep recordings, and real deployments.

---

## Prerequisites

| Resource | Required For | Notes |
|---|---|---|
| Checkly account | All acceptance | API key + Account ID |
| Checkly API key | `checkly-acceptance`, `checkly:verify` | Stored in `CHECKLY_API_KEY` env |
| Checkly Account ID | `checkly-acceptance`, `checkly:verify` | Stored in `CHECKLY_ACCOUNT_ID` env |
| Vercel project | `checkly:verify` | Protected preview deployment |
| Vercel Automation Bypass Secret | `checkly:verify` | `CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET` |
| Deployed slots-booking app | `checkly:verify` | `https://slots-booking-verify-fix.vercel.app` (or your deployment) |
| Upstash Redis | App runtime | Connected to Vercel project |
| Multistep regional accounts | `checkly:verify` | `MULTISTEP_USER_US_EAST_1`, `MULTISTEP_USER_EU_CENTRAL_1` |

**Environment file** (`checkly.env`, mode `0600`):
```bash
MULTISTEP_USER_US_EAST_1=...
MULTISTEP_USER_EU_CENTRAL_1=...
CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET=...
```

---

## Command 1: Capture Real Checkly Evidence

```bash
VERIFY_FIX_ACCEPTANCE_CHECK_ID=c68a06fe-6062-4d02-b31c-9ab4331f8cbe \
VERIFY_FIX_ACCEPTANCE_RESULT_ID=01a0e54e-298a-79b4-befe-5d4416ead2e5 \
VERIFY_FIX_ACCEPTANCE_PASS_RESULT_ID=01a0da9c-a20d-779d-b580-1858634db851 \
VERIFY_FIX_ACCEPTANCE_PROJECT=examples/slots-booking/web \
npm run test:checkly-acceptance
```

**What it does:**
1. Authenticates with Checkly API
2. Confirms the requested check and result identities
3. Pages result history for the check
4. Downloads and validates the selected Multistep assets (failing + passing)
5. Binds both result captures (failing + passing) by identity
6. Writes a sanitized v3 bundle to a temporary directory
7. **Does not** run the verifier or claim a repair passed

**Output:** Temporary bundle directory path printed to stdout.

---

## Command 2: Full Multistep Verification Acceptance

```bash
VERIFY_FIX_ACCEPTANCE_CHECK_ID=c68a06fe-6062-4d02-b31c-9ab4331f8cbe \
VERIFY_FIX_ACCEPTANCE_RESULT_ID=01a0e54e-298a-79b4-befe-5d4416ead2e5 \
VERIFY_FIX_ACCEPTANCE_PASS_RESULT_ID=01a0da9c-a20d-779d-b580-1858634db851 \
VERIFY_FIX_ACCEPTANCE_TARGET=https://slots-booking-verify-fix.vercel.app \
VERIFY_FIX_ACCEPTANCE_ENV_FILE=/absolute/path/to/private/checkly.env \
VERIFY_FIX_ACCEPTANCE_PATCH=examples/slots-booking/patches/slots-booking-multistep-nested-response \
VERIFY_FIX_ACCEPTANCE_PROJECT=examples/slots-booking/web \
npm run test:checkly:verify
```

**What it does:**
1. Captures real failing and passing Checkly results again (fresh)
2. Verifies their bound Multistep evidence (zero problems expected)
3. Measures 20 repetitions of the original check against the live application
4. Invokes the actual `verify-fix verify` CLI for three candidates:
   - **Known nested-response repair** → expected `PASS` / exit 0
   - **Unchanged original check** → expected `FAILED` / exit 1
   - **Valid repair without a target** → expected `UNCERTAIN` / exit 2
5. Writes JSON and Markdown reports under the temporary evidence bundle

**The repaired check contract is evaluated against the unchanged live app.** This command does not edit or deploy the Checkly check.

---

## Evidence Produced

Both commands write reports to the temporary bundle directory:

| File | Content |
|---|---|
| `report.json` | Machine-readable: scenes, verdict, oracle strength, cloud/local/mutation runs, browser processes, wall time, cost |
| `report.md` | Human-readable: summary table, per-scene details, evidence binding, gate eligibility |

**Example verdict structure:**
```json
{
  "verdict": "PASS",
  "targetBinding": { "gateEligible": true, "exactRevision": true },
  "scenes": [
    { "id": "healthy-1", "type": "HEALTHY", "mode": "live", "verdict": "PASS", "oracleStrength": 1.0 },
    { "id": "repro-1", "type": "REPRODUCTION", "mode": "replay", "verdict": "PASS", "oracleStrength": 1.0 },
    { "id": "detect-1", "type": "DETECTION", "mode": "inject", "verdict": "PASS", "oracleStrength": 1.0 },
    { "id": "mutant-1", "type": "MUTATION", "mode": "live", "verdict": "FAILED", "oracleStrength": 1.0 }
  ],
  "cost": { "cloudRuns": 3, "localRuns": 40, "mutationRuns": 4, "browserProcesses": 23, "wallTimeMs": 184000 }
}
```

---

## Known Limitations

| Limitation | Impact |
|---|---|
| **Hobby plan region restriction** | `eu-west-1` no longer available on Hobby; example uses `eu-central-1` |
| **Check-run quota** | Hobby plan limits scheduled runs; blocks PR gate demo (can't deploy repaired check) |
| **No Vercel API token** | Gate uses GitHub deployment statuses only; no Vercel API calls |
| **Manual only** | Acceptance commands require credentials; not in CI |

---

## Running Locally Without Acceptance

The example project runs fully locally (no Checkly credentials):

```bash
cd examples/slots-booking/web
npm ci --ignore-scripts
npm run build
npm run start &                    # http://localhost:3000
ENVIRONMENT_URL=http://localhost:3000 TEST_USER=demo npx playwright test
```

CI does this automatically: `.github/workflows/checkly.yml` builds, starts the app, and runs Playwright against `localhost:3000`.