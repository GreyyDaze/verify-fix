# verify-fix — verification & completion plan

Created after re-checking the code, the committed bundles, and a fresh test run
(499 tests, 499 pass, 0 fail, 0 skipped). This document exists because phase
verification evidence was recorded inconsistently across `PLAN.md`, commit
messages, and the bundles themselves. This file is the single place that says
what is proven, what is not, and in what order the remainder gets finished.

Numbering follows `docs/PLAN.md` (repo Phase 5.5 = candidate revisions,
repo Phase 8 = CLI init, repo Phase 9 = protected guarantees).

---

## 1. Current state

| Phase | Code | Local tests | Real account | Verdict |
| --- | --- | --- | --- | --- |
| 0 real app + project | done | — | deployed | **Done** |
| 1 `bundle` capture | done | done | real capture | **Done** |
| 2 / 2b overlap + drift incidents | done | done | 2 real bundles, `local-runner` determinism | **Done** |
| 3 scene layer | done | done | synthetic only | **Done** |
| 4 Playwright runner | done | done | real Chromium | **Done** |
| 5 CI gate | done | done | run `36041826149` | **Done** |
| 5.5 candidate revisions | done | done | protected proof `01f71b8` | **Done** |
| 6 API checks | done | thin | 3 real runs | **Done, weak coverage** |
| 7 Multistep | done | synthetic only | none | **No real proof** |
| 8 CLI init | none | none | none | **Done; `npm create` removed** |
| 9 protected guarantees | Stage 1 only | done | none | **Inert (shadow)** |

### Evidence confirmed by inspection

- Phase 8 is not started: no `init` command in `src/cli.ts`, no `init` in
  `package.json`, no `packages/` directory.
- Phase 9 is inert: `src/cli.ts:122` defaults `requirementsMode: "shadow"`, and
  every gate (`src/verify.ts:390`, `:414`, `:638`) is gated behind
  `=== "enforce"`. Masking changes are computed but never block.
- Phase 7 has no real capture: only 5 `manifest.json` files exist on disk
  (2 Playwright fixtures, 1 API incident, 2 seeded DSL bundles). None is a real
  Multistep capture.
- Of the historical captures, only the API incident manifest recorded
  `determinism.method: "checkly-cloud"`. Both Playwright bundles recorded
  `local-runner`, which the docs state openly. None of those bundles is
  committed today; a developer captures them locally when needed.

### Candidate fixture coverage (the repair matrix)

A phase is only properly verified when the app is healthy, the fault is in the
check, and a hand-written correct repair plus hand-written fake repairs are run
through the CLI against the captured incident.

| Check family | Correct repairs | Fake repairs | Real incident | Status |
| --- | --- | --- | --- | --- |
| Playwright — overlap | 3 | 11 | yes | **solid** |
| Playwright — drift | 1 | 4 | yes | **solid** |
| API (`ApiCheck`) | 1 | 1 | yes | **thin** |
| Multistep | 1 | 0 | no | **unproven** |
| `check()` DSL | 13 | — | seeded only | synthetic |

---

## 2. Ordering rule

Local verification first, real-account verification second, implementation
last — but Phase 8's implementation is verified *by* its own real run, so the
two cannot be separated for that phase.

```
Track A  close the verification gaps on code that already exists  (7, 9)
Track B  strengthen candidate coverage on proven families        (6)
Track C  implement and verify the last phase                     (8)
```

Track B is cheap and independent; run it alongside Track A. Tracks A and C must
be sequential because Phase 8 must not ship on top of an unproven Multistep
path — a learner's first real incident would fail for reasons unrelated to what
they are learning.

---

## 3. Track A — close verification gaps on existing code

### A1. Phase 7 Multistep: real account proof

Blocker: the entire family is unproven. Code is complete; evidence is synthetic.

**Local first**

1. Add the missing fake-candidate fixtures under
   `fixtures/patches/slots-booking-multistep-nested-response/`:
   - `01-good-nested-field` (already present, rename for clarity)
   - `02-loose-operator` — `toBe(true)` weakened to a property matcher
   - `03-delete-assertion` — remove the booking assertion
   - `04-catch-ignore` — swallow the failing expect
   - `05-remove-step` — drop the confirm step
   - `06-hardcode` — assert a constant instead of the response
   - `07-missing-await` — remove `await` from a transaction step
   - `08-reorder-steps` — reorder the transaction
2. Add a driver spec that drives each candidate through the real CLI and
   asserts the verdict, mirroring how `test/execution/scene/rules.spec.ts`
   grades the Playwright families.
3. Assert the expected matrix: good repair PASS; `02`–`08` FAILED; no candidate
   may reach PASS.

**Then real account**

4. Deploy the five-step Multistep check to the real Checkly project with two
   regional identities distinct from the browser/API users.
5. Cause the real incident. Note the app already returns nested
   `booking.confirmed` while the checked-in check still asserts flat
   `body.confirmed` — that stale assertion is the incident, and it must not be
   repaired as part of Phase 7.
6. `npm run test:checkly-acceptance` — captures the real failing and passing
   results, writes a sanitized bundle.
7. `npm run test:checkly:verify` — re-captures, verifies Multistep evidence,
   measures 20 repetitions, then asserts three CLI verdicts:
   nested-response repair PASS (0), unchanged original FAILED (1), repair
   without a target UNCERTAIN (2).
8. Keep the sanitized bundle outside the repository. Do not add a golden test
   over it: the suite keeps no captured or synthetic bundle.
9. Run the protected gate against the repair at an exact PR head; confirm both
   locations go green on the scheduled run.
10. Capture the Multistep bundle with `--measure N` so its determinism is
    recorded as `checkly-cloud` rather than `local-runner` (§A2).

Required inputs: `VERIFY_FIX_ACCEPTANCE_CHECK_ID`,
`VERIFY_FIX_ACCEPTANCE_RESULT_ID`, `VERIFY_FIX_ACCEPTANCE_PASS_RESULT_ID`,
`VERIFY_FIX_ACCEPTANCE_TARGET`, a 0600 `VERIFY_FIX_ACCEPTANCE_ENV_FILE` holding
the two `MULTISTEP_USER_*` values and the approved
`CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET`, plus Checkly credentials.

### A2. Playwright bundles: cloud-measured determinism

Blocker: both real Playwright incidents record
`determinism.method: "local-runner"`, so the determinism gate is open on local
numbers. The incidents themselves are genuine captures; only the measurement is
local. The historical API incident bundle was the only one that recorded
`checkly-cloud`, so Phase 6 already demonstrates the intended standard. These
bundles are not committed; capture them locally to re-measure.

This is a measurement upgrade, not a missing feature. The docs state the current
values openly and do not claim cloud provenance for them.

**Local first**

1. Nothing to build. `--measure N` exists (`src/capture/bundle/measure.ts`) and Phase 1
   ran it live. Re-capture outside the repository, so any diff is attributable
   to the re-measure rather than to a fixture change.

**Then real account**

2. Re-capture both bundles with cloud determinism, preserving the existing
   sanitized evidence:

   ```bash
   verify-fix bundle --check <overlap-check-id> --out "$HOME/.verify-fix/bundles/slots-booking-overlap" --measure 20
   verify-fix bundle --check <drift-check-id>   --out "$HOME/.verify-fix/bundles/slots-booking-drift"   --measure 20
   ```

   Keep both bundles outside the repository (or under the ignored
   `incidents/` directory). No captured bundle is committed.

3. For the overlap bundle also pass `--measure-overlap N` so the
   `live-concurrent:2` reproduction is measured, not assumed. The existing
   bundle records a 20/20 sequential baseline and a 20/20 reproduction; both
   numbers must come back from the cloud run.
4. Verify each re-captured manifest records `determinism.method: "checkly-cloud"`
   with `measured: true` and no regression in `achieved` versus the local run.
5. Diff the sanitized evidence against the committed bundles. Expect only the
   determinism block, fresh result IDs, and timestamps to change. Any change to
   `recordings/`, `rca.json`, or the scene oracles is a signal — stop and
   investigate before committing.
6. Re-run the scene matrix against both re-measured bundles so the
   Phase 3/4 verdicts (overlap `01`/`12` PASS, `02`–`10`/`13` FAILED, `11`
   never PASS; drift `01` PASS, `02`–`05` FAILED) are re-proven against the
   re-measured bundles.
7. Record the cloud run IDs in the bundle README and in `PLAN.md` next to the
   corresponding phase rows, so provenance is traceable to a real run.

**Ordering note:** run A2 after A1. If Phase 7's real capture changes how scenes
are derived, the Playwright bundles should be re-captured once, not twice.

### A3. Phase 9 protected guarantees: stages 2 and 3

Blocker: the gate computes but cannot block. Default is `shadow`.

**Local first**

1. Complete the 9.15 proof matrix as fixtures, covering at minimum:
   inheritance, overrides, new/unknown settings, location changes, concurrency
   changes, retries, activation, alert behaviour, new monitor discovery,
   imported configuration, sibling impact, policy tampering, missing and
   duplicate accounts, candidate-controlled reproduction, positive testing,
   falsification, regression, and secret leakage.
2. Assert the expected fixture table from `PLAN.md` exactly:

   | Candidate | Expected | Runs |
   | --- | --- | --- |
   | `01-good-run-parallel-false` | FAILED, exit 1 | 0 |
   | `12-good-one-location` | FAILED, exit 1 | 0 |
   | `13-config-retry-only` | FAILED, exit 1 | 0 |
   | `14` missing regional value | UNCERTAIN, exit 2 | 0 |
   | `14` equal regional values | FAILED, exit 1 | 0 |
   | `14` valid distinct values | PASS, exit 0 | full set |
   | App-side session repair | PASS, exit 0 | full set |

   The 0-run cases are the important ones: they prove the static gate fires
   before any browser or cloud execution.
3. Assert `src/evidence/assertion/id.ts` and `src/decision/decision.ts` are byte-unchanged
   (9.x forbids altering the assertion identity or the verdict law).

**Then real account**

4. Stage 1 — shadow: run the existing real Playwright overlap incident in
   `enforce` mode against the live account and record every verdict that would
   change. Confirm zero false positives and zero false UNCERTAIN.
5. Stage 2 — migration: add versioned requirements to the active bundles
   captured for the live account (kept outside the repository), pin their
   digests in `.github/workflows/protected-gate.yml`, and confirm requirements
   are derived from trusted config, never from candidate files.
6. Stage 3 — enforcement: flip the default in `src/cli.ts` from `shadow` to
   `enforce`, run the full suite, then prove the real gate blocks a bad fix and
   passes a good one on a live pull request.

**Do not skip Stage 1.** The plan requires shadow rollout and bundle migration
to complete before CI enforcement.

---

## 4. Track B — strengthen candidate coverage on proven families

### B1. API family: real hand-written candidates

Blocker: the API matrix is 1 good + 1 fake, and both were built by string
replacement in the removed `test/api/verify.spec.ts` rather than as files. Coverage of
the fake categories currently lives in policy unit tests, not in candidate
files driven through the CLI.

**Local first**

1. Create `fixtures/patches/slots-availability-api/` as real directories, one
   per candidate, matching the layout already used for the Playwright families:
   - `01-good-field-rename` — `jsonBody("availability")` → `jsonBody("status")`
   - `02-remove-assertion`
   - `03-weaken-operator` — `equals` → `contains`
   - `04-redirect-health` — point the check at `/health`
   - `05-rewrite-response` — rewrite the body in setup
   - `06-suppress-setup`
   - `07-retry-only`
   - `08-timeout-mask`
   - `09-hardcode-status`
   - `10-hardcoded-host`
2. Add a driver spec that runs each through the real `verify()` CLI entry point
   against a locally captured API incident bundle (never a committed one) and asserts:
   `01` PASS; `02`–`10` FAILED; missing target UNCERTAIN.
3. Add an imported-helper variant proving 9.4 resolves assertions, constants,
   and setup helpers from the final candidate tree.
4. Delete the string-replacement construction from the spec once the file-based
   candidates cover it, so there is one source of truth per candidate.

**Then real account**

5. Re-run the protected preview gate against `01` and one representative fake
   (`05`) to confirm the verdicts hold against real Checkly execution, not only
   the local scene executor.

Note: this family differs from the Playwright families in direction. The API
incident was caused by the *app* changing (`availability` → `status`), so the
repaired check asserts the new contract. Both directions are legitimate and
both must be covered; do not force the API fixtures into the "app fine, check
broken" shape.

---

## 5. Track C — implement and verify Phase 8

Blocked until Track A completes.

### C1. `verify-fix init`

1. Add the command to `src/cli.ts` following the existing dispatch shape
   (`bundle`, `measure`, `verify`, `cost-report`).
2. Detect the existing Checkly project: `checkly.config.ts`, Playwright config,
   package manifest, existing `incidents/` directory.
3. Write only the agreed CLI configuration and package scripts, and only after
   explicit confirmation.
4. Never provision services, never read or store credentials, never create or
   copy the example.

### C2. `create-verify-fix` (removed)

Removed. The copy command depended on `examples/slots-booking/web` inside this
repository and could not work as a published package. The example is now
repository-local test data only; `verify-fix init` remains the supported setup
command for existing Checkly projects.

### C3. Example README

Own the full learner workflow in the copied project's README: GitHub repo,
Vercel deploy, Upstash, Checkly auth, scheduled check deploy, protected
environments, every verify-fix command, recovery from setup failure, expected
Checkly usage and alerts, and teardown of all external resources. Credentials
stay in the learner's environment. Rocky Automatic Repair stays off.

### C4. Local verification

1. `npm pack`.
2. Run packed `verify-fix init` against a temporary existing Checkly project
   outside this repository.
3. Confirm the configured project has no repository-relative imports, and that
   no mock, secret, pre-captured incident, build cache, report, or raw trace
   enters it.

### C5. Real verification

5. From the user's machine, complete the full account-backed workshop in the
   copied project: GitHub → Vercel → Upstash → Checkly → real incident from two
   locations sharing one test account → `verify-fix bundle` → repair branch →
   verify against exact preview URL and revision → pull request → CI gate PASS
   → `checkly deploy`. A bad repair must FAIL. No captured incident is copied in.

---

## 6. Definition of done for the whole project

- Phase 7 has a real sanitized Multistep bundle, recorded parity, a protected
  PASS, and a repaired scheduled run green in both locations.
- Phase 9 stages 1–3 complete; the default mode is `enforce`; the fixture table
  in §3.A3 holds with the 0-run cases proven.
- Both Playwright bundles record `determinism.method: "checkly-cloud"` with cloud
  run IDs, and the Phase 3/4 scene verdicts are re-proven against them (§A2).
- API family has a hand-written candidate matrix driven through the CLI, with
  real-account confirmation.
- Phase 8 ships as two packed commands, proven locally against external
  projects and then through a real account-backed workshop.
- Every phase row in §1 reads Done in all three evidence columns.
- `npm test` green, `npm run typecheck` clean, root and example builds pass.
- `src/evidence/assertion/id.ts` and `src/decision/decision.ts` unchanged throughout.

## 7. Standing rules

- No LLM in the decision path. Verdict evidence comes from executed experiments.
- A synthetic fixture proves verifier mechanics under stated assumptions. It is
  never Checkly, browser, deployment, or cloud proof.
- Missing evidence is `UNCERTAIN`, never `PASS`.
- Credentials only from the environment; never written into projects, bundles,
  or reports.
- Rocky Automatic Repair stays off; its RCA is passive evidence and is never
  followed blindly.