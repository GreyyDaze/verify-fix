# User Guide

## What is verify-fix?

`verify-fix` is a deterministic CLI that grades candidate patches to monitoring checks (Playwright, API, Multistep) against captured incident evidence. It answers: **Does this patch fix the application bug, or just silence the alarm?** No LLM in the decision path — exit codes `0` (PASS), `1` (FAILED), `2` (UNCERTAIN).

---

## Installation

```bash
# Global install
npm i -g verify-fix

# Or use via npx (always latest)
npx verify-fix --help
```

Requires Node.js 22+.

**Platforms:** macOS, Linux, and Windows. The CLI itself is cross-platform, but the CI gate (`scripts/ci-gate.sh`) is a POSIX bash script — on Windows run it under WSL, Git Bash, or use the GitHub Action wrapper, which runs bash for you.

---

## Quick Start

### 1. Deploy Your App + Checks
Your app runs on Vercel (or any host). Checks run on Checkly (Playwright suite, ApiCheck, Multistep).

### 2. Capture the Incident
When a check fails, capture it with the failing result ID and a passing baseline:

```bash
verify-fix bundle \
  --check <CHECK_ID> \
  --result <FAILING_RESULT_ID> \
  --pass-result <PASSING_RESULT_ID> \
  --out ./bundle
```

This downloads the check, recordings, assets, and Rocky RCA; writes a sanitized v3 bundle (`.tar.gz`) to `./bundle`; prints the SHA-256 fingerprint.

### 3. Write the Repair Patch
Create a patch file (or directory) with the proposed fix to the check source.

### 4. Grade the Patch
```bash
verify-fix verify \
  --bundle ./bundle \
  --patch ./fix.patch \
  --target https://your-deployment.example \
  --candidate-revision <EXACT_40_HEX_SHA> \
  --base origin/main \
  --executor hybrid \
  --cloud-approved
```

**Verdict:**
- `PASS` (exit 0) — Repair works, evidence binds, mutations rejected.
- `FAILED` (exit 1) — Silencing detected, regression, or oracle too weak.
- `UNCERTAIN` (exit 2) — Missing evidence, flaky, no requests made.

---

## Commands

| Command | Purpose | Key Flags |
|---|---|---|
| `verify-fix bundle` | Capture incident from Checkly | `--check`, `--result`, `--pass-result`, `--out`, `--measure` |
| `verify-fix verify` | Grade candidate patch | `--bundle`, `--patch`, `--target`, `--candidate-revision`, `--base`, `--executor`, `--requirements-mode`, `--requirements-digest`, `--report-json`, `--report-markdown` |
| `verify-fix verify --dry-run` | Preflight the wiring without executing anything | `--bundle`, `--patch`/`--candidate-project`/`--pr`, `--bundle-digest`, `--target-metadata`, `--project`, `--json` |
| `verify-fix init` | Configure an existing Checkly project (adds verify-fix scripts and bundle ignore rules; never creates a project) | `--yes` (required to write) |
| `verify-fix measure` | Measure determinism (20+ runs) | `--bundle`, `--target`, `--project`, `--runs` |
| `verify-fix cost-report` | Aggregate cost across reports | `--reports <dir>` |

Run `verify-fix <command> --help` for full flag list.

### Preflight before a real run

`--dry-run` checks everything a verification needs and then stops. It loads the bundle, verifies the fingerprint, and confirms the candidate source, project directory, deployment metadata, env file, and report paths exist. It opens no browser, makes no network call, and writes no report.

```bash
verify-fix verify \
  --bundle ~/.verify-fix/bundles/inc-123 \
  --bundle-digest <sha256> \
  --candidate-project . --base origin/main \
  --target https://preview.example.com \
  --dry-run
```

```
verify-fix preflight (dry run — no scenes executed, no network calls)

  ok    bundle               /Users/me/.verify-fix/bundles/inc-123
  ok    bundle fingerprint   matches sha256:...
  ok    candidate project    .
  ...
preflight: ok
```

Exit `0` means the wiring is sound. Exit `2` means at least one input is missing or mismatched, and each failed line says which. Add `--json` for the same result as machine-readable output.

---

## Gate Integration (CI/CD)

The provider-neutral gate is `scripts/ci-gate.sh`. It runs in any CI (GitHub Actions, GitLab, Jenkins, Bitbucket, local).

### Required Environment Variables

| Variable | Description |
|---|---|
| `VF_BUNDLE_DIR` | Local bundle directory (stored outside repo) |
| `VF_BUNDLE_DIGEST` | Bundle SHA-256 fingerprint (64 hex) |
| `VF_CANDIDATE_PROJECT` | Checkly project path in candidate checkout (e.g., `web`) |
| `VF_CANDIDATE_REVISION` | Exact 40-hex candidate SHA (clean tree) |
| `VF_BASE` | Base Git ref (e.g., `origin/main`) |
| `VF_TARGET` | Deployment origin (bare HTTPS, e.g., `https://preview.example`) |
| `VF_TARGET_REVISION` | Deployed revision (must equal `VF_CANDIDATE_REVISION`) |
| `VF_TARGET_METADATA` | Path to deployment metadata JSON (see below) |
| `CHECKLY_API_KEY` | Checkly API key |
| `CHECKLY_ACCOUNT_ID` | Checkly account ID |

### Optional Variables

| Variable | Description |
|---|---|
| `VF_REQUIREMENTS_MODE` | `shadow` (default) / `migration` / `enforce` |
| `VF_REQUIREMENTS_DIGEST` | Policy fingerprint (64 hex) |
| `VF_ENV_FILE` | Checkly environment file path |
| `VF_ENV_NAME` | Checkly environment name |
| `VF_PROJECT` | Checkly project name override |
| `VF_REPORT_JSON` | Output path for JSON report |
| `VF_REPORT_MARKDOWN` | Output path for Markdown report |
| `VF_CLI` | Path to a pinned `verify-fix` binary (default: the bundled one) |
| `VF_CLI_VERSION` | Expected `verify-fix --version`; the gate refuses to run on mismatch |

### GitHub Action Wrapper

The repository ships a composite action (`action.yml`) that runs the same script with typed inputs:

```yaml
- uses: GreyyDaze/verify-fix@v0.1.0
  with:
    bundle-dir: ${{ steps.capture.outputs.bundle }}
    bundle-digest: ${{ steps.capture.outputs.digest }}
    candidate-project: web
    candidate-revision: ${{ github.sha }}
    base: origin/main
    target: https://preview.example.com
    target-revision: ${{ github.sha }}
    target-metadata: ./deployment-metadata.json
    requirements-mode: shadow
    cli-version: 0.1.0
    checkly-api-key: ${{ secrets.CHECKLY_API_KEY }}
    checkly-account-id: ${{ secrets.CHECKLY_ACCOUNT_ID }}
```

### Pinning the Toolchain

The gate executes whatever `verify-fix` binary it finds. To make a build reproducible, install an exact release and pin it:

```bash
npm i -g verify-fix@0.1.0
export VF_CLI="$(command -v verify-fix)"
export VF_CLI_VERSION=0.1.0
```

If the installed CLI reports a different version, the gate exits `2` instead of grading with the wrong rules.

### Deployment Metadata (`VF_TARGET_METADATA`)

```json
{
  "provider": "vercel",
  "deploymentId": "dpl_abc123",
  "revision": "a1b2c3d4...",  // must equal VF_CANDIDATE_REVISION
  "url": "https://preview.example",
  "environment": "preview"
}
```

### Exit Codes

| Code | Meaning |
|---|---|
| 0 | PASS + gate-eligible |
| 1 | FAILED (silencing, regression, weak oracle) |
| 2 | UNCERTAIN (missing evidence, flaky) |
| 2+ | Configuration error (missing var, fingerprint mismatch, etc.) |

---

## Example Project

`examples/slots-booking/` — a complete Next.js app with Checkly checks:

```
examples/slots-booking/
├── web/                          # Next.js app + Checkly project
│   ├── __checks__/               # Checkly constructs (Checkly convention)
│   │   ├── availability.check.ts     # ApiCheck
│   │   ├── availability.setup.ts     # Setup script
│   │   ├── multistep-booking.check.ts # MultiStepCheck
│   │   └── multistep-booking.spec.ts # Transaction script
│   ├── tests/booking.spec.ts     # Playwright Check Suite (not a construct)
│   ├── checkly.config.ts         # Project + Playwright Check Suite
│   ├── playwright.config.ts      # Local/Checkly baseURL, bypass header
│   └── package.json
├── patches/                      # Candidate repairs (good + broken)
└── README.md
```

**Run locally:**
```bash
cd examples/slots-booking/web
npm ci --ignore-scripts
npm run build
npm run start &                    # http://localhost:3000
ENVIRONMENT_URL=http://localhost:3000 TEST_USER=demo npx playwright test
```

**CI runs this automatically** (`.github/workflows/checkly.yml`).

---

## Verdicts Explained

| Verdict | When | Action |
|---|---|---|
| **PASS** | All assertions bind, evidence matches, mutations rejected, regression clean | Merge / deploy |
| **FAILED** | Removed/weakened/caught assertion, vacuous (0 requests), flaky, mutation passes, regression detected | Reject patch |
| **UNCERTAIN** | Missing bundle/check identity, fingerprint mismatch, missing deployment metadata, no requests to target | Investigate / gather more evidence |

---

## Protected Requirements (Static Gate)

The static gate runs *before* any execution, comparing the candidate's effective Checkly config against sealed requirements from the bundle.

| Mode | Behavior | Use Case |
|---|---|---|
| `shadow` (default) | Static-requirement violations are reported only; the verdict is unchanged | Rollout observation |
| `migration` | Requires a pinned `--requirements-digest`; violations are reported only | Pinning requirements |
| `enforce` | Static-requirement violations fail the verdict (exit 1) | Production gate |

Modes govern the **static requirements gate only**. `shadow` does not turn a failing execution, a missing assertion, or a weak oracle into a pass — those still fail the verdict.

```bash
verify-fix verify --requirements-mode enforce --requirements-digest <sha256> ...
```

The gate adapter (`scripts/ci-gate.sh`) passes `--requirements-mode shadow` unless overridden.

---

## Cost & Performance

Every report includes:
- Cloud runs (Checkly `test --record`)
- Local runs (Playwright sandbox)
- Mutation runs (4 per candidate)
- Browser processes spawned
- Per-scene wall time + total wall time

```bash
verify-fix cost-report --reports ./reports-dir
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `UNCERTAIN: no requests recorded` | Patch doesn't hit the target | Check `--target` URL, ensure check makes requests |
| `FAILED: assertion removed` | Patch deletes/weakens an original `expect` | Keep all original assertions; fix the app instead |
| `FAILED: mutation passed` | Oracle too weak (mutant not rejected) | Add more specific assertions; increase determinism runs |
| `FAILED: fingerprint mismatch` | Bundle was modified after capture | Re-capture; ensure bundle stored externally |
| `Configuration error: VF_* missing` | Gate env vars not set | Supply all required `VF_*` variables in CI |
| `VF_CLI_VERSION=... but the CLI reports ...` | Installed CLI is not the pinned version | Install the pinned release or update `VF_CLI_VERSION` |
| `verify-fix: command not found` | Not installed globally | `npm i -g verify-fix` or use `npx verify-fix` |
| `ci-gate.sh: bad interpreter` on Windows | Script needs a POSIX shell | Use WSL, Git Bash, or the GitHub Action wrapper |
| Bundle dir missing on first run | No capture yet | `verify-fix bundle ...` creates `~/.verify-fix/bundles/<incident-id>` automatically |

---

## Further Reading

- `ARCHITECTURE.md` — System design and data flow
- `DESIGN-DECISIONS.md` — Key architectural choices and tradeoffs
- `TESTING.md` — Test strategy and taxonomy
- `ACCEPTANCE.md` — Real Checkly provider acceptance commands