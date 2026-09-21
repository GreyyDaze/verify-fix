# verify-fix — Brainstorm: where we are, where we go

Plain English. Short sentences. Technical details kept.

---

## Part 1 — The current tool (today)

### What you give it
- A **bundle** folder. Inside: `manifest.json` (the exam paper), `check/` (the original check), `app-sim.ts` (a fake website).
- A **patch** file (the proposed new check).

### What it does well
- Reads old and new check. Lists every `expect(...)`. Flags removed, weakened, or `catch`-wrapped alarms. (Static diff.)
- Runs the patch in a sealed child process. 20-second timer. Seeded `Math.random`.
- Counts real requests to the target. Zero requests = vacuous = UNCERTAIN. Never PASS.
- Runs each scene 3–5 times. Disagreeing runs = UNCERTAIN.
- Makes four broken copies of the patch (mutants). Checks it would reject each.
- Ordered rulebook. No AI. Exit 0 / 1 / 2.
- 25 automated tests. Real fix passes. Ten fakes fail. Same result every run.

### What is wrong for production
1. **The manifest is hand-written.** Scenes, oracles, assertion ids, determinism numbers. A human typed them. Nobody will.
2. **`app-sim.ts` is hand-written, per incident.** It is a fake backend. For a browser check this is the wrong shape: the browser talks to the real backend. Nobody will write a fake per incident.
3. **The manifest's assertion ids are stale.** Coverage reads 0.00. This is what hand-written data does.
4. **The Checkly executor is a dry-run stub.** Without a key it returns UNCERTAIN.
5. **The sandbox DSL only knows `fetch` + `expect`.** No Playwright `page`. Browser checks cannot run.

### Honest value today
- It proves the rulebook and the evidence gate work.
- It does not plug into a real workflow yet. Without the hand-made bundle, it has nothing to grade.

---

## Part 2 — What production systems do (research)

- **Meta TestGen-LLM.** LLM writes tests. Then filters, no LLM: must build, must pass, must pass all 5 repeated runs (else flaky, discarded). Only then a human reviews. "Generate and test."
- **SWE-bench.** A patch is accepted only if tests that failed now pass (fail_to_pass) **and** tests that passed still pass (pass_to_pass). Known gap: stubbing out behavior still scores a pass. That is why we also need a "must fail" scene and the static diff.
- **Checkly.** Everything a bundle needs already exists behind the CLI/API:
  - `npx checkly checks get <id>` → check + results. `GET /v1/check-results/{checkId}/{resultId}`.
  - CLI v8.8.0: list and download result assets — logs, Playwright traces, videos, screenshots, pcaps.
  - Rocky AI RCA in CLI/API: `checkly rca run --error-group <id>`, `checkly rca get <id>`. Gives classification, root cause, evidence, suggested fix. Automatically compares with the **last passing result**.
  - `checkly test` runs checks from your machine against the real target. Records by default.
- **Playwright.** `routeFromHAR()` records real traffic once and replays it offline. `page.route()` + `route.fulfill({ status: 401 })` forces one endpoint to fail while everything else stays real. The two can be layered.
- **Keploy / WireMock.** Record real API traffic → mocks generated automatically. WireMock adds explicit fault injection.
- **Datadog self-healing tests.** A healed step is validated by running it against the live app. The user's assertions define what is expected.

**The lesson:** nobody writes simulators. They **record real runs** and **inject faults at the network layer**. Oracles come from real results: the last passing run (must pass) and the failing step (must fail when forced).

---

## Part 3 — The new design (target)

### 3.1 Two commands
```
verify-fix bundle --check <checkId> [--result <failingResultId>] --out ./bundle
verify-fix verify --patch fix.ts --bundle ./bundle
```
`bundle` builds the exam paper. `verify` grades. The user writes nothing.

### 3.2 What `bundle` pulls (Checkly CLI/API, `CHECKLY_API_KEY` from env)
1. The check definition and its source (repo file, or from the check).
2. The **failing result** and its assets: log, Playwright trace (contains every request and response), screenshots.
3. The **last passing result** and its assets.
4. The **Rocky RCA**: which step failed, which request, what status, classification, suggested fix.
5. Sibling checks in the same group and their last passing results (for regression).

### 3.3 What `bundle` writes
```
bundle/
├── manifest.json            generated, not typed
├── check/<file>.ts          original check
└── recordings/
    ├── failing.har          extracted from the failing trace
    └── passing.har          extracted from the passing trace
```
Manifest contents, generated:
- **Scenes** with a `mode`: `live`, `live-concurrent:N`, `replay:<har>`, `inject:<rule>`.
- **Oracles**: `mustFail` true/false. **Provenance**: real result ids (`recorded:<resultId>`), not made up.
- **Repetitions**: default 5 (Meta's number).
- **Env assumptions**: from the check config (env vars, locations, account).
- **Determinism**: measured, not typed. `bundle` runs the original check N times and records pass/fail rates.
- **Assertion ids**: generated from the check source at bundle time. Coverage becomes real.
- **No `app-sim.ts`.**

### 3.4 The scenes, and where each comes from
| Scene | Oracle | Source of truth | How it runs |
|---|---|---|---|
| HEALTHY | must pass | last passing result exists | `live`, ×5 |
| REPRODUCTION | must pass after the fix | failing result + RCA classification | race/concurrency → `live-concurrent:2`; changed response → `replay:failing.har` |
| DETECTION | **must fail** | the failing request (e.g. `POST /book → 401`) | `inject: POST /book → 401` on top of live or replay, ×5 |
| REGRESSION | must pass | sibling checks' last passing results | `live`, ×2 |

Why two REPRODUCTION modes:
- Our overlap incident is a **race**. A recording bakes the 401 in. Replay can't show a fix working. But two copies run at once on the real target reproduce it for real, because the real backend really has one-session-per-account.
- A **changed response** incident (field renamed, status changed) is the opposite. Replay of the failing traffic is exact. The fixed check must pass against it.
- The RCA classification picks the mode. Unknown → run both; if neither reproduces, the scene is UNCERTAIN. Not faked.

### 3.5 One generic scene layer (written once, used for every incident)
- **Browser / Playwright checks.** The patch runs under real Playwright. Before the check body: HEALTHY → nothing (live). REPRODUCTION → `routeFromHAR(failing.har)` or two concurrent contexts. DETECTION → `page.route(<failing request>, r => r.fulfill({ status: 401 }))`. REGRESSION → live. The browser talks to the **real backend**. No fake app.
- **API / fetch checks.** The sandbox points the check at a small local proxy (`APP_BASE_URL` or `HTTPS_PROXY`). Proxy modes: `passthrough` (live), `replay` (from HAR), `inject` (rewrite one matching request), `concurrent` (N sandboxes at once). Same manifest, same modes.
- **Evidence gate stays.** The route/proxy counts real hits. Zero hits → vacuous → UNCERTAIN.
- Code shape: today's `AppSim { start, drive(scene), close }` interface stays. The fixture-specific implementation is replaced by one generic `SceneLayer`.

### 3.6 What does not change
Static assertion diff. Evidence gate. Repetitions. Four mutants. Ordered rulebook. Exit codes 0/1/2. Report format. The seeded 11-patch suite must stay green.

---

## Part 4 — Our booking check, the new way

1. Alert fires on `slots-booking`.
2. `verify-fix bundle --check slots-booking` pulls: failing result (`POST /book → 401`), last passing result, RCA ("second login invalidated the first session"; classification: check concurrency).
3. Generated manifest: HEALTHY `live ×5`; REPRODUCTION `live-concurrent:2 ×3`; DETECTION `inject POST /book → 401 ×5, mustFail`; REGRESSION sibling checks `live ×2`.
4. An agent writes `fix.ts` (take a lock, or set check concurrency to 1).
5. `verify-fix verify --patch fix.ts --bundle ./slots-booking`.
6. Same rulebook. Real fix → PASS. `catch-ignore` fake → stays quiet on the injected 401 → DETECTION mismatch → FAILED.

Nothing was hand-written. The fake website is gone.

---

## Part 5 — Honest limits and open questions

- **Live scenes need a real environment** and a test account. They spend check runs. Budget per scene stays.
- **Replay reproduces responses, not timing.** Races need `live-concurrent`.
- **DETECTION must know which request to break.** It comes from the failing result. If it can't be found → one line of config, or UNCERTAIN.
- **Browser checks need real Playwright in the sandbox.** New runtime, not the tiny DSL.
- **Determinism must be measured**, which costs N runs of the original check at bundle time.
- **Credentials** live in `CHECKLY_API_KEY` in your environment. Never in chat or the repo.
- **verify-fix only applies when the fix lands in the check.** If the RCA says the app or infra is broken, there is no check patch to grade.

---

## Part 6 — Phases

1. **`bundle` command against recorded fixtures.** Sample Checkly result JSON + trace → manifest + HAR. Unit tests. No key needed.
2. **Generic scene layer for fetch checks.** Local proxy: live / replay / inject / concurrent. Replace the fixture `app-sim.ts` with recordings. Keep the 11-patch suite green.
3. **Playwright runner for browser checks.** `page.route` / `routeFromHAR` / concurrent contexts.
4. **Live Checkly path.** Real key, real check, real alert → bundle → verify.
