# verify-fix — Brainstorm: where we are, where we go

Plain English. Short sentences. Technical details kept.
Revision 3: Part 7 decisions aligned with how Checkly actually works; D1 details from Checkly's env-var rules; D9 CI path.

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
  - Rocky AI RCA in CLI/API: `checkly rca run --error-group <id>`, `checkly rca get <id> --output json`. Gives classification, root cause, cited evidence (HTTP traces, assertions, timings), suggested fix. Automatically compares with the **last passing result**.
  - `checkly test` runs checks against the target you point it at. Records by default.
- **Playwright.** `routeFromHAR()` records real traffic once and replays it offline. `page.route()` + `route.fulfill({ status: 401 })` forces one endpoint to fail while everything else stays real. The two can be layered.
- **Keploy / WireMock.** Record real API traffic → mocks generated automatically. WireMock adds explicit fault injection.
- **Datadog self-healing tests.** A healed step is validated by running it against the live app. The user's assertions define what is expected.

**The lesson:** nobody writes simulators. They **record real runs** and **inject faults at the network layer**. Oracles come from real results: the last passing run (must pass) and the failing step (must fail when forced).

---

## Part 3 — The new design (target)

### 3.1 Two commands
```
verify-fix bundle --check <checkId> [--result <failingResultId>] --out ./bundle
verify-fix verify --patch fix.ts --bundle ./bundle --target <name>
```
`bundle` builds the exam paper. `verify` grades. The user writes nothing.
`--target` names an environment the **customer** provides (see Part 7, D1).

### 3.2 What `bundle` pulls (Checkly CLI/API, `CHECKLY_API_KEY` from env)
1. The check definition, its config (frequency, locations, retries, env vars) and its source.
2. The **failing result** and its assets: log, Playwright trace (every request and response), screenshots.
3. The **last passing result** and its assets.
4. The **Rocky RCA**: which step failed, which request, what status, classification, suggested fix, and which surface the fix belongs to (check code, check config, app, infra).
5. Sibling checks in the same group and their last passing results (for regression).

### 3.3 What `bundle` writes
```
bundle/
├── manifest.json            generated, not typed
├── check/<file>.ts          original check
├── check.config.json        original check config (frequency, locations, retries, env var names)
└── recordings/
    ├── failing.har          extracted from the failing trace
    └── passing.har          extracted from the passing trace
```
Manifest contents, generated:
- **Scenes** with a `mode`: `live`, `live-concurrent:N`, `replay:<har>`, `inject:<rule>`.
- **Oracles**: `mustFail` true/false. **Provenance**: real result ids (`recorded:<resultId>`), not made up.
- **Repetitions**: default 5 (Meta's number).
- **Env assumptions**: from the check config (env var names, locations, test user). Not typed.
- **Determinism**: measured, not typed. `bundle` runs the original check N times on the target and records pass/fail rates.
- **Assertion ids**: generated from the check source at bundle time. Coverage becomes real.
- **No `app-sim.ts`.**

### 3.4 The scenes, where each comes from, and how much the environment matters
| Scene | Oracle | Source of truth | How it runs | Depends on staging = production? |
|---|---|---|---|---|
| HEALTHY | must pass | last passing result exists | `live` ×5 | **Yes.** Report says so. |
| REPRODUCTION | must pass after the fix | failing result + RCA classification | race/collision → `live-concurrent:2`; changed response → `replay:failing.har` | race mode: partly (same business rule needed). replay mode: **no**, responses are the real recorded ones |
| DETECTION | **must fail** | the failing request (e.g. `POST /book → 401`) | `inject` that failure on top of live or replay, ×5 | **Barely.** The failure is injected. Only the steps before it run live. |
| REGRESSION | must pass | sibling checks' last passing results | `live` ×2 | **Yes.** Report says so. |

Why two REPRODUCTION modes (this matters — see Part 7, D5):
- Our overlap incident is a **race**. A recording bakes the 401 in. Replaying it serves 401 to *every* check, including the real fix. Under replay the real fix would observe `fail`, the oracle says `pass` → FAILED. Wrong verdict. So races need two copies running at once on the real target, where the real one-session-per-account rule reproduces the collision for real.
- A **changed response** incident (field renamed, status changed) is the opposite. Replay of the failing traffic is exact. The fixed check must pass against it.
- The RCA classification picks the mode. Unknown → run both; if neither reproduces, the scene is UNCERTAIN. Not faked.

### 3.5 One generic scene layer (written once, used for every incident)
- **Browser / Playwright checks.** The patch runs under real Playwright. Before the check body: HEALTHY → nothing (live). REPRODUCTION → `routeFromHAR(failing.har)` or two concurrent contexts. DETECTION → `page.route(<failing request>, r => r.fulfill({ status: 401 }))`. REGRESSION → live. The browser talks to the **real backend**. No fake app.
- **API / fetch checks.** The sandbox points the check at a small local proxy. Proxy modes: `passthrough` (live), `replay` (from HAR), `inject` (rewrite one matching request), `concurrent` (N sandboxes at once). Same manifest, same modes.
- **Evidence gate stays.** The route/proxy counts real hits. Zero hits → vacuous → UNCERTAIN.
- Code shape: today's `AppSim { start, drive(scene), close }` interface stays. The fixture-specific implementation is replaced by one generic `SceneLayer`.

### 3.6 What does not change
Static assertion diff. Evidence gate. Repetitions. Four mutants. Ordered rulebook. Exit codes 0/1/2. Report format (plus one new column, see D3). The seeded 11-patch suite must stay green.

---

## Part 4 — Our booking check, the new way

1. Alert fires on `slots-booking`.
2. `verify-fix bundle --check slots-booking` pulls: failing result (`POST /book → 401`), last passing result, RCA ("second login invalidated the first session"; classification: check concurrency; surface: check).
3. Generated manifest: HEALTHY `live ×5`; REPRODUCTION `live-concurrent:2 ×3`; DETECTION `inject POST /book → 401 ×5, mustFail`; REGRESSION sibling checks `live ×2`.
4. An agent writes `fix.ts` (take a lock, or a config change that stops overlapping runs).
5. `verify-fix verify --patch fix.ts --bundle ./slots-booking --target staging`.
6. Same rulebook. Real fix → PASS. `catch-ignore` fake → stays quiet on the injected 401 → DETECTION mismatch → FAILED.

Nothing was hand-written. The fake website is gone.

---

## Part 5 — Honest limits and open questions

- **Live scenes need a real environment** and a test user. They spend check runs. Budget per scene stays.
- **Replay reproduces responses, not timing.** Races need `live-concurrent`.
- **DETECTION must know which request to break.** It comes from the failing result and the RCA's cited evidence. If it can't be found → one line of config, or UNCERTAIN.
- **Browser checks need real Playwright in the sandbox.** New runtime, not the tiny DSL.
- **Determinism must be measured**, which costs N runs of the original check at bundle time.
- **Credentials** live in env vars (`CHECKLY_API_KEY`, test user secrets). Never in chat or the repo.
- **verify-fix only applies when the fix lands in the check** (code or config). If the RCA says the app or infra is broken, there is no check patch to grade.
- **Staging is not production.** HEALTHY and REGRESSION inherit whatever gap the customer's staging has. The report labels it (D3). REPRODUCTION-by-replay and DETECTION mostly do not depend on it.

---

## Part 6 — Phases

1. **`bundle` command against recorded fixtures.** Sample Checkly result JSON + trace → manifest + HAR. Unit tests. No key needed.
2. **Generic scene layer for fetch checks.** Local proxy: live / replay / inject / concurrent. Replace the fixture `app-sim.ts` with recordings. Keep the 11-patch suite green.
3. **Playwright runner for browser checks.** `page.route` / `routeFromHAR` / concurrent contexts.
4. **Live Checkly path.** Real key, real check, real alert → bundle → verify.

---

## Part 7 — Design decisions, aligned with how Checkly works (revision 2)

Context: this proposal is aimed at Checkly. So where Checkly already has a convention, we adopt it instead of inventing one.

### D1. The customer brings the environment. We use Checkly's convention to point at it.
- Checkly's own model: the same check runs against a preview or staging URL when `ENVIRONMENT_URL` is set, and against production on its schedule. Browser checks read `process.env.ENVIRONMENT_URL`; API checks get only the host replaced (path and query stay). `npx checkly test -e ENVIRONMENT_URL="https://staging.example.com"` passes it at runtime.
- **Decision:** `verify-fix verify --target staging` sets `ENVIRONMENT_URL` (and `ENVIRONMENT_NAME`) exactly like Checkly does. We drop our private `APP_BASE_URL`. A check that already follows Checkly's convention needs no change to be verifiable.
- We do not provision, seed, or manage environments. Same contract as `checkly test`.

Details from Checkly's environment-variable rules that shape the implementation:
- **`-e` is session-only.** Values passed with `--env` / `--env-file` apply to that test session only; they never update the variables used by scheduled monitors. So `--target` is a per-run override. verify-fix **never** calls `checkly deploy` or `checkly env add`. It only grades.
- **Two mechanisms, one variable name.** Prepending `ENVIRONMENT_URL=… npx checkly test` does nothing — local env vars are not replaced inside code dependencies. When a scene runs through Checkly's runner (D4) we must pass `-e` / `--env-file`. When a scene runs in our local sandbox we set `process.env` directly. Same name, different plumbing.
- **Accept `--env-file`.** `verify-fix verify --env-file ./.env.staging` uses the same file the customer already keeps for `checkly test --env-file` (or pulls with `checkly env pull`). No new config format. The file stays out of git.
- **Handlebars have no fallback.** API-check constructs reference `{{ENVIRONMENT_URL}}`; if the variable is unset the check cannot run at all. The bundle records how the check resolves its target: `code` (has a fallback) or `handlebars` (none). A missing target variable is reported **UNCERTAIN — "target variable not set"**, never FAILED.
- **Names, not values.** The bundle stores env var *names* only. Secrets stay in the customer's shell, CI secret store, or Checkly's encrypted remote variables (D8).

### D2. Two targets are allowed; scenes are assigned by risk.
- `--target staging` (default): all scenes, including `inject` and `live-concurrent`.
- `--target production` (optional, read-only, dedicated test user): HEALTHY and REGRESSION only. Never `inject`, never `live-concurrent`, never anything that writes. Checkly's own checks run against production continuously with dedicated test users, so this is normal — but it is the customer's call.

### D3. The report says where every piece of evidence came from.
- New column `environment` on each row: `live:staging`, `live:production`, `replay:recorded(<resultId>)`, `inject:on-live:staging`.
- Reasons line for live-on-staging rows: "confidence depends on staging/production parity".
- Nothing else in the rulebook changes. A human or a pipeline can weight HEALTHY/REGRESSION as they see fit. DETECTION and replay rows do not carry that caveat.

### D4. Where scenes execute: split between Checkly's runner and our local sandbox.
- **HEALTHY and REGRESSION** can run through `checkly test -e ENVIRONMENT_URL=... --record` on Checkly's own runtime and locations. Most faithful. Produces a recorded test session with traces. Rocky can even analyze test-session error groups.
- **DETECTION and REPRODUCTION** run in our local sandbox against the customer's target, because fault injection (`page.route` / local proxy) and forced concurrency need control of the runtime. Checkly's cloud runners hit the URL directly; we cannot sit in between.
- The rulebook does not care which runner produced a row. This is the executor interface we already have.

### D5. Keep two REPRODUCTION modes. Do not use HAR replay for races.
- Replay serves the recorded 401 to any check, including a correct fix. The real fix would be graded FAILED. So: races and session collisions → `live-concurrent`; changed responses → `replay`. The RCA classification decides; unknown → both, then UNCERTAIN if neither reproduces.
- This corrects a shortcut in the review thread ("REPRODUCTION = replay, environment-independent, high confidence"). It is only true for the changed-response class.

### D6. Where verify-fix sits in Checkly's loop.
- Checkly's loop today: alert → Rocky RCA → coding agent fixes → `checkly test` → `checkly deploy`. The only verification step is "the check is green again".
- Green is exactly what every fake fix produces. **verify-fix is the gate between "agent fixed it" and "deploy".** It consumes what the loop already has: the failing result, the last passing result, the RCA, and the target URL.
- CI shape, following Checkly's own pipelines: deploy app → `verify-fix verify` (exit 0 required) → `checkly deploy`.

### D7. Patches can be config, not only code.
- Rocky says the fix may land in "check config". On Checkly that means frequency, locations, retry strategy, env vars, `shouldFail`, timeouts.
- Some config changes are legitimate fixes for our incident class (stop overlapping runs). Some are the `08-timeout-mask` vector in config form (turn on retries, silence the alarm).
- **Decision:** the bundle stores `check.config.json`; the static diff also diffs config. Retry/timeout increases alone → flagged like an assertion weakening. Concurrency/scheduling changes → allowed, and must then pass `live-concurrent` REPRODUCTION.

### D8. Changing the test user is not automatically a fake.
- Checkly's guidance: use dedicated test users, never hardcode credentials, always read them from env vars.
- Today `detectEnvScopeDodge` flags any credential change. Too blunt for production.
- **Decision:** a credential that is **generated at runtime** (`Date.now()`, `randomUUID()`) stays a dodge. A credential that **moves to a different env var** is a declared environment change: allowed, recorded as an updated env assumption in the report, and the scenes must still hold. Hardcoded credentials in a patch are rejected outright.

### D9. CI integration goes through the CLI / GitHub Action path, not deployment hooks.
- Checkly offers two ways to run checks on a deployment: GitHub deployment hooks (Checkly listens for `deployment_status` events) and the CLI / GitHub Action (your pipeline starts a recorded test session).
- Deployment hooks have documented limits: private locations are not available, client certificates are not applied, OpenTelemetry headers are not applied. Staging behind a firewall needs private locations.
- **Decision:** verify-fix runs as a pipeline step, the same way `checkly test` does: deploy app → `verify-fix verify --target staging --env-file ./.env.staging` (exit 0 required) → `checkly deploy`. It does not register deployment hooks and does not depend on them.

### What did not change after the review
The rulebook. The evidence gate. Repetitions. Mutants. Exit codes. The two hand-made parts are still removed. The tool's job is still: decide if a patch is real or fake, given evidence. The customer's job is still: provide a URL that behaves like the thing that broke.
