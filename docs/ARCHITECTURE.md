# Architecture

## Problem Statement

AI agents increasingly propose patches to monitoring checks (Playwright, API, Multistep) when checks fail. The easiest way to make a red check green is not to fix the application bug but to **silence the alarm**: delete the failing assertion, weaken the expected value, wrap in `try/catch`, retry until it passes, or switch to a fresh test account. `verify-fix` is a deterministic oracle that grades candidate patches against captured incident evidence — no LLM in the decision path.

## Core Concept

Two-phase model:

1. **Capture** — Record a failing Checkly check run (with passing baseline) into a sealed, fingerprinted evidence bundle. The bundle is the "exam paper": manifests, HAR, traces, assets, Rocky RCA output.
2. **Verify** — Grade a candidate patch against that bundle using a scene proxy (live target, replay, or fault injection) and a policy engine (sealed requirements, sibling regression). Verdict: `PASS` / `FAILED` / `UNCERTAIN` (exit 0/1/2).

## Architecture Flow

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

## Key Components

| Component | Location | Responsibility |
|---|---|---|
| **Bundle Capture** | `src/capture/` | Checkly API client, history paging, asset download (HAR, traces, ZIP), Rocky RCA → `REPRODUCTION` mode, manifest v3, SHA-256 fingerprint |
| **Scene Proxy** | `src/execution/scene/proxy.ts` | Concurrency-controlled request interception; modes: `live`, `replay:<har>`, `inject:<method> <path> → <status>`; one listener per concurrent run |
| **Executors** | `src/execution/executor/` | `playwright-sandbox.ts` (local Chromium, JSON reporter), `checkly-cli.ts` (cloud `checkly test --record`), `hybrid.ts` (cloud for HEALTHY/REGRESSION, local for REPRODUCTION/DETECTION) |
| **Policy Engine** | `src/policy/` | `requirements.ts` (sealed envelope `protected-requirements-v2`, comparison modes), `sibling-impact.ts` (file→monitor mapping, REGRESSION scenes) |
| **CLI** | `src/cli.ts` | `bundle`, `verify`, `init`, `measure`, `cost-report`; argument parsing, report emission |
| **Gate Adapter** | `scripts/ci-gate.sh` | Provider-neutral: bundle + exact revision + deployment metadata + Checkly creds → runs verifier, exits non-zero unless PASS + gate-eligible |

## Data Model

**Bundle v3** (`.tar.gz`, pinned by SHA-256):
- `manifest.json` — schema version, check type, logical ID, capture timestamp, fingerprint
- `check/` — original check construct source (`*.check.ts`, `*.spec.ts`, setup scripts)
- `recordings/` — failing + passing Multistep recordings (bound by identity)
- `assets/` — HAR, Playwright traces, compressed result bodies
- `results/history.json` — recent scheduled runs for determinism measurement

**Candidate Revision**:
- Exact 40-hex SHA, clean tree (or dirty flag + diff)
- PR metadata (number, head SHA, base SHA, fork flag)
- Source: `git-revision` | `github-pr` | `local-dirty`

**Verdict Report**:
- Per-scene: type (`HEALTHY`/`REPRODUCTION`/`DETECTION`/`REGRESSION`/`MUTATION`), mode, verdict, oracle strength
- Aggregated: overall verdict, gate eligibility, cloud/local/mutation run counts, browser processes, wall time
- Machine-readable JSON + human Markdown

## Security Model

- **Bundles never in candidate repo** — stored externally (GitHub Actions artifact, local `~/.verify-fix/bundles/`, or any object store). Fingerprint proves integrity.
- **Secrets only in CI env** — `CHECKLY_API_KEY`, `TEST_USER_*`, `MULTISTEP_USER_*`, `VERCEL_AUTOMATION_BYPASS_SECRET` never touch the bundle or logs.
- **Gate fails closed** — missing bundle, fingerprint mismatch, missing check identity, missing deployment metadata → immediate non-zero exit.
- **Candidate code never trusted** — requirements derived from live Checkly API + captured result, sealed in bundle before candidate runs.

## Security Model

- **Bundles never in candidate repo** — stored externally (GitHub Actions artifact, local filesystem, or object store). Fingerprint proves integrity.
- **Secrets only in CI env** — `CHECKLY_API_KEY`, `TEST_USER_*`, `MULTISTEP_USER_*`, `VERCEL_AUTOMATION_BYPASS_SECRET` never touch the bundle or logs.
- **Gate fails closed** — missing bundle, fingerprint mismatch, missing check identity, missing deployment metadata → immediate non-zero exit.
- **Candidate code never trusted** — requirements derived from live Checkly API + captured result, sealed in bundle before candidate runs.

## Techniques

This section describes how verify-fix implements each capability deterministically.

### 1. Technique: Content-Addressed Evidence Bundles

**How:** Every bundle is a versioned archive (`.tar.gz`) with a computed SHA-256 fingerprint over all files (path + NUL + bytes, sorted by POSIX relative path). The fingerprint is recorded in the manifest and validated before grading.

**Why:** Content-addressing makes bundles tamper-evident and makes fingerprint comparison O(1).

**Implementation:** `src/capture/bundle/digest.ts` — recursive traversal, type-constraint check (plain file/dir only; rejects symlinks/sockets/devices), deterministic ordering.

### 2. Technique: Assertion Identity Diffing

**How:** The candidate patch's assertions are matched against the original check's assertions. Each original assertion is tracked by an ID derived from its position and content. Removed, weakened, or caught assertions are classified.

**Why:** A silencing patch typically deletes an assertion or weakens the expected value. Matching by identity (not just count) catches subtle changes.

**Implementation:** `src/evidence/assertion/` + `src/execution/scene/config-diff.ts` — scheduling allowed, retry/timeout-only rejected, new env keys declared.

### 3. Technique: Multi-Mode Scene Proxy

**How:** The scene proxy accepts four request modes:
- `live` — real HTTP to the deployment target
- `replay:<har>` — deterministic replay from captured HAR
- `inject:<method> <path> -> <status>` — fault injection

Concurrency is controlled by a lockstep mechanism: one listener per concurrent run, interleaving requests in the declared order.

**Why:** One abstraction covers REPRODUCTION (live), REGRESSION (replay), and DETECTION (inject).

### 4. Technique: Deterministic Measurement

**How:** `verify-fix measure` runs a scene N times (default 20) against a target and compares results. Oracle strength is computed as agreement ratio.

**Why:** Disagreement across runs → UNCERTAIN (flaky). Agreement → pass. This is the basis for HEALTHY/DETECTION/REGRESSION verdicts.

**Implementation:** `src/execution/scene/` — measurement records (pass/fail per run), deterministic seeds, bounded history.

### 5. Technique: Mutation Gate

**How:** For each candidate patch, the tool generates up to four mutants (broken variants of the patch). Each mutant must be rejected (FAILED/UNCERTAIN). If any mutant passes the oracle, the candidate fails.

**Why:** Guards against weak oracles that can't distinguish a real fix from a silencing change.

### 6. Technique: Sealed Requirements Static Gate

**How:** Before execution, the final effective Checkly configuration (from live API) is resolved, sealed into the bundle's requirements envelope (`protected-requirements-v2`), and compared against the candidate's effective config.

**Why:** The candidate's source files are untrusted. The *effective* config (what Checkly actually runs) is the source of truth.

### 7. Technique: Hybrid Execution

**How:** The executor routes by verdict type:
- `HEALTHY` / `REGRESSION` → Checkly cloud (`checkly test --record`)
- `REPRODUCTION` / `DETECTION` → local scene proxy

**Why:** Cloud for production-level checks, local for deterministic/falsifying runs.

---

## Deployment

- **CLI**: Published npm package (`verify-fix`), entrypoint `bin/verify-fix`, `engines.node >=24`.
- **CI Gate**: `scripts/ci-gate.sh` — POSIX bash, runs anywhere (GitHub Actions, GitLab, Jenkins, Bitbucket, local). GitHub Actions reference adapter in `.github/workflows/ci.yml` (repo CI) and example CI in `examples/slots-booking/.github/workflows/checkly.yml`.
- **Example**: `examples/slots-booking/` — Next.js app + Checkly project (Playwright suite, ApiCheck, Multistep) in one project, `__checks__/` convention, local CI runs Playwright against `localhost:3000`.