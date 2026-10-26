# verify-fix

> **A deterministic oracle that grades candidate patches to monitoring checks (Playwright, API, Multistep) against captured incident evidence — no LLM in the decision path.**

[![npm version](https://img.shields.io/npm/v/verify-fix?label=verify-fix)](https://www.npmjs.com/package/verify-fix)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## The Problem

AI agents increasingly propose patches to failing monitoring checks. The easiest way to make a red check green is **not to fix the application bug** but to **silence the alarm**:

- Delete the failing assertion
- Weaken the expected value
- Wrap in `try/catch`
- Retry until it passes
- Switch to a fresh test account

**verify-fix** catches all of these. It grades a candidate patch against the *actual incident evidence* using deterministic rules. Exit codes: `0` (PASS), `1` (FAILED), `2` (UNCERTAIN).

---

## How It Works — Two-Phase Model

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  Checkly Check  │────▶│  verify-fix      │────▶│  Sanitized v3      │
│  fails          │     │  bundle          │     │  Bundle (.tar.gz)  │
│  (incident)     │     │  --check <id>    │     │  fingerprint: sha256│
└─────────────────┘     └──────────────────┘     └─────────┬──────────┘
                                                           │
                    ┌──────────────────┐                   │
                    │  Candidate Patch │                   ▼
                    │  (agent PR)      │──────────▶ ┌────────────────────┐
                    └──────────────────┘            │  Scene Proxy       │
                                                   │  • live (real app) │
                                                   │  • replay:<har>    │
                                                   │  • inject:METHOD   │
                                                   └─────────┬──────────┘
                                                             │
                    ┌──────────────────┐                   ▼
                    │  Executors       │──────────▶ ┌────────────────────┐
                    │  • Playwright    │            │  Policy Engine     │
                    │  • Checkly Cloud │            │  • Sealed reqs     │
                    │  • Hybrid        │            │  • Sibling reg.    │
                    └──────────────────┘            │  • Mutation gate   │
                                                   └─────────┬──────────┘
                                                             │
                                                   ┌─────────▼──────────┐
                                                   │  Verdict Report    │
                                                   │  PASS/FAILED/UNC.  │
                                                   │  Scenes, evidence, │
                                                   │  cost, wall time   │
                                                   └────────────────────┘
```

### Phase 1: Capture
```bash
verify-fix bundle --check <CHECK_ID> --result <FAIL_RESULT> --pass-result <PASS_RESULT> --out ./bundle
```
- Downloads check construct, recordings, HAR, traces, Rocky RCA output
- Seals effective requirements from live Checkly API (what Checkly *actually* runs)
- Writes a fingerprinted `.tar.gz` — the "exam paper" that cannot be edited by the candidate

### Phase 2: Verify
```bash
verify-fix verify --bundle ./bundle --patch ./fix.patch --target https://your-deploy.example --candidate-revision <SHA> --executor hybrid
```
- Runs the candidate against a **Scene Proxy** (live, replay, or fault injection)
- Enforces **sealed requirements** (static gate runs first)
- Measures **oracle strength** via 20+ deterministic repetitions
- Runs **mutation gate** — 4 broken mutants must all be rejected
- Checks **sibling monitors** for regressions
- Emits machine-readable JSON + human Markdown report

---

## The Five Rules That Catch Silencing

| Rule | What It Catches | Verdict |
|------|-----------------|---------|
| **Assertion Identity** | Deleted/weakened/caught assertions | `FAILED` |
| **Evidence Binding** | Zero requests to target (vacuous pass) | `UNCERTAIN` |
| **Oracle Strength** | Flaky results across 20 runs | `UNCERTAIN` |
| **Mutation Gate** | Broken mutant passes (oracle too weak) | `FAILED` |
| **Sibling Regression** | Patch breaks another monitor | `FAILED` |

---

## Architecture Highlights

| Component | Technique |
|-----------|-----------|
| **Bundles** | Content-addressed (SHA-256 over sorted paths), stored externally, never in candidate repo |
| **Requirements** | Derived from live Checkly API + captured result, sealed before candidate runs |
| **Execution** | Single Scene Proxy handles `live`, `replay:<har>`, `inject:<method> → <status>` with lockstep concurrency |
| **Identity** | Multistep bound to construct (logical ID + source), not region — region is just account selector |
| **Verdict** | Pure deterministic rules, exit codes 0/1/2, no LLM |
| **Gate** | POSIX script `scripts/ci-gate.sh` — works in GitHub Actions, GitLab, Jenkins, Bitbucket, local |
| **Rollout** | Shadow (report-only) → Migration (pinned digest) → Enforce (block PRs) |

---

## Quick Start

```bash
# Install
npm i -g verify-fix   # or: npx verify-fix

# 1. Capture the incident (when a check fails)
verify-fix bundle \
  --check c68a06fe-6062-4d02-b31c-9ab4331f8cbe \
  --result 01a0e54e-298a-79b4-befe-5d4416ead2e5 \
  --pass-result 01a0da9c-a20d-779d-b580-1858634db851 \
  --out ./bundle

# 2. Grade the candidate patch
verify-fix verify \
  --bundle ./bundle \
  --patch ./patches/fix-assertion.patch \
  --target https://slots-booking-verify-fix.vercel.app \
  --candidate-revision a1b2c3d4e5f6... \
  --executor hybrid \
  --requirements-mode enforce
```

**Output:** `PASS` (exit 0) / `FAILED` (exit 1) / `UNCERTAIN` (exit 2) + detailed JSON/Markdown report.

---

## CI/CD Gate Integration

The provider-neutral gate is a single POSIX script: **`scripts/ci-gate.sh`**

```yaml
# .github/workflows/gate.yml (example)
- name: Run verify-fix gate
  env:
    VF_BUNDLE_DIR: ${{ steps.bundle.outputs.path }}
    VF_BUNDLE_DIGEST: ${{ steps.bundle.outputs.digest }}
    VF_CANDIDATE_PROJECT: web
    VF_CANDIDATE_REVISION: ${{ github.sha }}
    VF_BASE: origin/main
    VF_TARGET: https://preview.example.com
    VF_TARGET_REVISION: ${{ github.sha }}
    VF_TARGET_METADATA: ./deployment-metadata.json
    VF_REQUIREMENTS_MODE: enforce          # or shadow / migration
    CHECKLY_API_KEY: ${{ secrets.CHECKLY_API_KEY }}
    CHECKLY_ACCOUNT_ID: ${{ secrets.CHECKLY_ACCOUNT_ID }}
  run: scripts/ci-gate.sh
```

**Exit codes:**
| Code | Meaning |
|------|---------|
| 0 | PASS + gate-eligible |
| 1 | FAILED (silencing, regression, weak oracle) |
| 2 | UNCERTAIN (missing evidence, flaky) |
| 3+ | Configuration error (missing var, fingerprint mismatch) |

Prefer a typed interface? The same gate ships as a composite GitHub Action:

```yaml
- uses: GreyyDaze/verify-fix@v0.1.0
  with:
    bundle-dir: ${{ steps.capture.outputs.bundle }}
    bundle-digest: ${{ steps.capture.outputs.digest }}
    candidate-project: web
    candidate-revision: ${{ github.sha }}
    target: https://preview.example.com
    target-revision: ${{ github.sha }}
    target-metadata: ./deployment-metadata.json
    requirements-mode: shadow
    cli-version: 0.1.0
    checkly-api-key: ${{ secrets.CHECKLY_API_KEY }}
    checkly-account-id: ${{ secrets.CHECKLY_ACCOUNT_ID }}
```

Pin the toolchain with `VF_CLI` + `VF_CLI_VERSION`; the gate refuses to run if the installed CLI version differs.

---

## Example Project — `examples/slots-booking/`

A complete Next.js app with Checkly checks demonstrating correct patterns:

```
examples/slots-booking/
├── web/                          # Next.js + Checkly project
│   ├── __checks__/               # Checkly constructs (Checkly convention)
│   │   ├── availability.check.ts     # ApiCheck
│   │   ├── availability.setup.ts     # Setup script
│   │   ├── multistep-booking.check.ts # MultiStepCheck
│   │   └── multistep-booking.spec.ts # Transaction script
│   ├── tests/booking.spec.ts     # Playwright Check Suite (not a construct)
│   ├── checkly.config.ts         # Project config + checkMatch + retryStrategy
│   ├── playwright.config.ts      # Local/Checkly baseURL, bypass header
│   └── package.json
├── patches/                      # Candidate repairs (good + broken variants)
└── .github/workflows/checkly.yml # Local CI: build, start on localhost:3000, run Playwright
```

**Run locally (no Checkly credentials needed):**
```bash
cd examples/slots-booking/web
npm ci --ignore-scripts
npm run build
npm run start &                    # http://localhost:3000
ENVIRONMENT_URL=http://localhost:3000 TEST_USER=demo npx playwright test
```

---

## Documentation

| Document | What's Inside |
|----------|---------------|
| [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) | Complete manual — install, commands, gate integration, verdicts, troubleshooting |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, data flow, components, security model, **7 implementation techniques** |
| [`docs/DESIGN-DECISIONS.md`](docs/DESIGN-DECISIONS.md) | 7 architectural choices with rationale/tradeoffs, grouped by responsibility |
| [`docs/TESTING.md`](docs/TESTING.md) | Test taxonomy (6 categories), principles, 196 tests in CI, why not other approaches |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | Real Checkly provider acceptance commands (capture + full verification), prerequisites |

See [`SECURITY.md`](SECURITY.md) for the vulnerability disclosure process.

---

## Test Suite

```bash
npm run typecheck   # clean
npm test            # 196 tests pass (Node native test runner)
```

| Category | Tests | Real Provider? |
|----------|-------|----------------|
| Unit / Contract (policy, checks, capture, report) | 126 | No |
| CLI Integration | 19 | No (real CLI) |
| Application Integration (execution) | 34 | Local app |
| Workflow / CI (gate adapter) | 7 | No |
| External Package (revision) | 10 | No |
| **Total (CI)** | **196** | — |
| Real Provider Acceptance | 2 commands | **Yes** (opt-in, manual) |

---

## Real Provider Acceptance (Manual)

```bash
# Capture real Checkly evidence
VERIFY_FIX_ACCEPTANCE_CHECK_ID=... \
VERIFY_FIX_ACCEPTANCE_RESULT_ID=... \
VERIFY_FIX_ACCEPTANCE_PASS_RESULT_ID=... \
npm run test:checkly-acceptance

# Full Multistep verification against live app
VERIFY_FIX_ACCEPTANCE_CHECK_ID=... \
VERIFY_FIX_ACCEPTANCE_TARGET=https://slots-booking-verify-fix.vercel.app \
VERIFY_FIX_ACCEPTANCE_PATCH=examples/slots-booking/patches/slots-booking-multistep-nested-response \
npm run test:checkly:verify
```

Requires: Checkly API key + account, Vercel project with bypass secret, deployed app, regional test accounts.

---

## License

MIT — see [`LICENSE`](LICENSE) for details.