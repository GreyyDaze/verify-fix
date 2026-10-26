# Testing Strategy

This document describes the test taxonomy, principles, and how correctness is proven without cargo-culting.

---

## Test Taxonomy

| Category | Scope | Real Provider? | CLI Real? | Application Real? | Location |
|---|---|---:|---:|---:|---|
| **Unit / Contract** | One implementation rule (assertion diff, policy compare, digest, taxonomy) | No | Usually no | No | `test/policy/`, `test/checks/`, `test/evidence/` |
| **CLI Integration** | Production CLI wiring, argument parsing, exit codes, report emission | No | Yes | Often yes | `test/verify.spec.ts` |
| **Application Integration** | Real verification behavior against local app | No (local app) | Yes in key tests | Yes | `test/execution/`, `test/candidate/` |
| **Workflow / CI** | GitHub Actions structure, shell blocks, env lifecycle | No | No or partial | No | `test/workflow/ci-gate-adapter.spec.ts` |
| **External Package** | Installed package works outside repo | No | Yes | Synthetic/local | `test/candidate/revision.spec.ts` |
| **Real Provider Acceptance** | Checkly API, asset download, Multistep verification | **Yes** | Yes | Depends on target | `scripts/checkly-acceptance.ts`, `scripts/checkly-verify-acceptance.ts` |

---

## Principles

### 1. No Committed Bundles
- **No captured bundle** (real or synthetic reconstruction) is committed to the repo.
- Tests that need evidence build a disposable bundle in a temporary directory from generic inputs and delete it.
- Real bundles are captured on demand via `npm run test:checkly-acceptance` (opt-in, requires credentials).
- Replaying one example project's incident only couples tests to that example and proves nothing generic.

### 2. Real Acceptance Is Opt-In
- `npm run test:checkly-acceptance` and `npm run test:checkly:verify` require:
  - Checkly API key + account ID
  - Vercel project with protected preview + bypass secret
  - Deployed slots-booking app
  - Regional test accounts (`MULTISTEP_USER_*`)
- These commands are **not** in CI. They are run manually by maintainers before releases.

### 3. Determinism Measured, Not Assumed
- `verify-fix measure --bundle --target --project --runs 20` records 20+ repetitions per scene.
- Oracle strength reported per scene (0.0–1.0). Disagreement → UNCERTAIN.
- Mutation testing: every repair candidate has broken variants that must FAIL.

### 4. Mutation Gate in Tests
- The test suite includes synthetic candidates (good repair + broken variants).
- Each variant is verified; the good one must PASS, all broken ones must FAIL.
- This exercises the full pipeline: assertion diff → evidence binding → oracle strength → mutation rejection.

### 5. Test Structure Mirrors Source
- `test/` folders mirror `src/` by responsibility:
  ```
  test/
  ├── policy/           # requirements, sibling-impact
  ├── checks/           # multistep, api, problem-taxonomy
  ├── evidence/         # assertion, contract, adequacy
  ├── execution/        # sandbox, rules, scene
  ├── candidate/        # revision, patch
  └── workflow/         # ci-gate-adapter
  ```
- One level per responsibility. No `test/README.md`. No meta/prose assertions.

---

## Current Coverage (as of `feat/verify-fix-implementation`)

| Suite | Tests | Focus |
|---|---:|---|
| Unit / Contract | 126 | Policy comparison, assertion identity, problem taxonomy, bundle digest, capture mechanics, cost report |
| CLI Integration | 19 | Version/help contract, argument parsing, init planning, local measure |
| Application Integration | 34 | Playwright sandbox, Checkly executor, scene proxy modes, rules |
| Workflow / CI | 7 | `ci-gate.sh` syntax, env handling, provider-agnostic flags, version pinning |
| External Package | 10 | Temp project creation, revision snapshot, dirty detection |
| **Total (CI)** | **196** | **All run in `npm test` (Node native test runner)** |

Real-provider acceptance: 2 commands (capture + verify), run manually.

---

## Running Tests

```bash
# Full suite (CI)
npm test

# Typecheck only
npm run typecheck

# Build
npm run build

# Real provider acceptance (manual, requires credentials)
npm run test:checkly-acceptance   # captures bundle to temp dir
npm run test:checkly:verify       # full verification against live app
```

---

## Why Not Other Approaches

| Approach | Why Not |
|---|---|
| Committed bundle fixtures | Couples tests to one incident; candidate could edit bundle; secrets risk |
| Mocked Checkly client in all tests | Doesn't prove real asset download, RCA binding, or cloud execution parity |
| LLM-based verdict in tests | Non-deterministic; defeats the purpose of the tool |
| Single test file with everything | Hard to navigate, hard to isolate failures, no responsibility boundaries |