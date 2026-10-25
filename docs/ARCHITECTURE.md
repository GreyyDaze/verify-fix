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

## Deployment

- **CLI**: Published npm package (`verify-fix`), entrypoint `bin/verify-fix`, `engines.node >=24`.
- **CI Gate**: `scripts/ci-gate.sh` — POSIX bash, runs anywhere (GitHub Actions, GitLab, Jenkins, Bitbucket, local). GitHub Actions reference adapter in `.github/workflows/ci.yml` (repo CI) and example CI in `examples/slots-booking/.github/workflows/checkly.yml`.
- **Example**: `examples/slots-booking/` — Next.js app + Checkly project (Playwright suite, ApiCheck, Multistep) in one project, `__checks__/` convention, local CI runs Playwright against `localhost:3000`.