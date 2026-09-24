# verify-fix — a complete guide to the project

This document explains the whole project from first principles: the problem, the
solution, the concepts it relies on, the architecture, every important piece of
code, how the pieces talk to each other, how to run it, what happens step by step
during a run, and where it works, does not work, or is incomplete. It is written
so that after reading it you can explain the project in your own words and defend
its technical decisions.

---

## 0. The one-paragraph version

Companies like Checkly run **monitoring checks**: small scripts (Playwright /
API tests) that continuously exercise a production app — log in, book a slot,
assert the booking is confirmed — and page someone when an assertion fails.
Increasingly, when a check fails, an **AI agent** proposes a patch to the check.
The danger is that the easiest way to make a red check green is not to fix the
problem but to **silence the alarm**: delete the assertion, wrap it in
`try/catch`, assert something that is always true, retry until it "passes",
switch to a fresh account so the bug never triggers, and so on. `verify-fix` is a
command-line tool that takes a **candidate patch** plus a recorded **incident
bundle** and decides — **deterministically, with no LLM anywhere in the decision
path** — whether the patch really repairs the recorded incident while still
detecting real failures. It answers `PASS` (exit 0), `FAILED` (exit 1) or
`UNCERTAIN` (exit 2), and every sentence in its report traces back to an
experiment that was actually executed.

---

## 1. The problem, and why it needs solving

### 1.1 Monitoring checks and Monitoring-as-Code

A monitoring check is a test that runs against production on a schedule (and
often also from CI or a developer's laptop). In Checkly's "Monitoring as Code"
model the check is a TypeScript file in a repo, written against Playwright-style
APIs:

```ts
check("slots-booking flow", async ({ baseUrl }) => {
  const login = await fetch(`${base}/login`, { ... account: "demo" ... });
  expect(login.status).toBe(200);
  const book = await fetch(`${base}/book`, { ... authorization: `Bearer ${token}` });
  expect(book.status).toBe(200);
  expect(body.confirmed).toBe(true);
  expect(body.booking).toBe("CONFIRMED");
});
```

The assertions are the check's **oracle**: they are what distinguishes "the app
is healthy" from "the app is broken".

### 1.2 The recorded incident

The fixture in this repo models a real class of bug (referenced in the manifest
from Checkly's feedback board: "one session per account"): the app allows **one
session per account**. A scheduled run and a CI-triggered run of the same check
**overlap**. The second run's login invalidates the first run's session, so the
first run's booking step gets `401`. Sequential runs always pass; overlapping runs
always fail. That is the incident `slots-booking-overlap`.

### 1.3 Why "just let the agent fix it" is dangerous

An agent asked to "make the check pass" has many cheap moves that produce a green
check without fixing anything. The repo seeds nine of them as fixtures
(`fixtures/slots-booking/patches/03…11`):

| vector | what the patch does | why it is bad |
|---|---|---|
| weaken assertion | `toBe(200)` → `toBeDefined()` | can never fail |
| catch/ignore | wrap the booking in `try { … } catch {}` | failure swallowed |
| trivially true | `expect(body).toBeDefined()` | asserts the object exists, not its meaning |
| hardcode | `expect(200).toBe(200)` | asserts constants, never the live flow |
| change account | `ACCOUNT = demo-${Date.now()}` | fresh account per run → the shared-session bug never triggers |
| timeout/retry mask | retry 3× then assert a constant | forced failures pass |
| remove step | delete the booking step | nothing left that can fail |
| symptom-only fix | pin the check to `"demo"` | breaks a second, recorded user flow (regression) |
| flaky | assert only when `Math.random() > 0.5` | sometimes catches, sometimes not |

Only one seeded patch (`01-good-serialize.ts`) is a genuine fix: it acquires a
per-account **serialization lock** before logging in so overlapping runs queue
instead of interfering (the check-level equivalent of "max concurrency = 1").

### 1.4 Why the verifier must be deterministic and LLM-free

If you use a second LLM to judge the first LLM's patch, you have moved the
problem, not solved it: the judge can be fooled, is non-reproducible, and its
"reasoning" cannot be audited. A pre-merge gate needs to be:

- **deterministic** — same inputs, same verdict, same evidence;
- **evidence-based** — every claim reduces to "experiment X, oracle Y,
  observed Z, matched/mismatched";
- **conservative** — when it cannot tell, it must say `UNCERTAIN`, never
  `PASS`;
- **cheap to audit** — a human should be able to merge/block in ~30 seconds from
  the report.

That is the design brief the code keeps referring to as the "PRD" and its
numbered requirements (`PR-1`, `PR-3`, `PR-6`, `PR-7`, `PR-10`, `PR-12`).

---

## 2. What verify-fix does

### 2.1 Inputs

1. **A candidate patch** — the full source of the repaired check file
   (`--patch fixtures/slots-booking/patches/01-good-serialize.ts`).
2. **An incident bundle** — a directory (`--bundle fixtures/.../slots-booking-overlap`)
   containing:
   - `manifest.json` — the incident's description, the check's identity, a list of
     **scenes** (experiments) with their **oracle verdicts**, the environment
     assumptions, the determinism evidence, and a run budget;
   - `check/booking.check.ts` — the check **as it was when the incident was
     recorded** (the "original");
   - `app-sim.ts` — a deterministic **simulator of the app under test**, which
     the synthetic executor can put into each scene's state.

### 2.2 Scenes = experiments with a known correct answer

The manifest defines five scenes. Each is an app state plus what a correctly
fixed check **must** observe there:

| scene | type | app state (`stateDriver.params.mode`) | oracle |
|---|---|---|---|
| `scene-a-overlap` | REPRODUCTION | `overlap` — a phantom second run logs in right after ours | fixed check must **pass** (3 repetitions) |
| `scene-b-single-run` | HEALTHY | `normal` | must **pass** (5 repetitions) |
| `scene-a-prime-overlap-variant` | REPRODUCTION | `overlap` (independent repro) | must **pass** (2) |
| `scene-c-auth-failure` | DETECTION | `auth-fail` — booking is genuinely broken (always 401) | must **fail** (5) |
| `scene-e-regression` | REGRESSION | `normal`, a *second independent user* books | must **pass** (2) |

The DETECTION scene is the crucial anti-fooling device: a patch that silences
the alarm will *pass* where a real failure exists, and that mismatch convicts it.

### 2.3 Outputs

- A Markdown report (or `--json`) with a table `experiment | oracle | expected |
  observed | match | strength`, an **adequacy** line (how strong the oracle is),
  the **reasons** for the verdict, and the top evidence lines.
- A verdict and a process exit code: `PASS`=0, `FAILED`=1, `UNCERTAIN`=2. CI can
  gate a merge on the exit code alone.

Concrete result for the good patch today:

```
**Verdict:** PASS (exit 0)
| scene-a-overlap               | code:assert:assert:55fcc552 | pass | pass | ✓ | 0.700 |
| scene-b-single-run            | code:assert:assert:55fcc552 | pass | pass | ✓ | 0.700 |
| scene-a-prime-overlap-variant | code:assert:assert:a8a58d76 | pass | pass | ✓ | 0.700 |
| scene-c-auth-failure          | code:assert:assert:a8a58d76 | fail | fail | ✓ | 0.700 |
| scene-e-regression            | code:assert:assert:43cb9d60 | pass | pass | ✓ | 0.700 |
**Adequacy:** oracle_strength = 0.700 (falsifiability 1.00, coverage 0.00, env 1.00, mutant-kill 1.00); threshold = 0.7
```

---

## 3. Concepts and techniques you need to know

### 3.1 The test-oracle problem
An oracle is whatever decides whether an observed behaviour is correct. A check's
`expect(...)` calls are its oracle for the app. verify-fix needs an oracle *for
the check*: that is what the scenes' `mustFail: true/false` verdicts are. The
code calls the origin of each scene's verdict its **provenance**, and allows
exactly two kinds (requirement PR-3):

- `recorded` — a real Checkly run id + artifact that showed the outcome;
- `code` — an assertion id in the check's own source (`code:assert:<id>`).

Anything else is rejected at ingestion (`contract.ts` → `provenanceViolations`
→ verdict `UNCERTAIN`). This is what makes the oracle auditable: every expected
outcome points at either a recorded run or a line of code.

### 3.2 Falsifiability (Popper, applied to assertions)
An assertion is only useful if some realistic breakage would make it fail.
`expect(x).toBe(200)` is falsifiable; `expect(x).toBeDefined()` or
`toBeGreaterThanOrEqual(0)` on an HTTP status is not (a 500 is defined and ≥ 0).
`src/assertion/classify.ts` is a table classifying every matcher as
`exact` (falsifiable) or `property` (usually not). The code calls the
non-falsifiable family the "weak assertions" weakness class.

### 3.3 The four weakness classes ("STING")
The adequacy engine scans the suite against four weakness classes the code
labels with the name STING:
1. **insufficient input space** — fewer than 3 scenes or fewer than 2 independent
   scene types;
2. **partial path coverage** — a scene that exercises no falsifiable assertion;
3. **weak assertions** — property matchers on the critical path;
4. **missing environment context** — unverified environment assumptions (the
   "3-vs-18 queues lesson" in the comments: a check that passes only because the
   environment differs from production).

### 3.4 Mutation testing, turned on the check
Classical mutation testing mutates the program and asks whether the tests notice.
Here the *check* is the program and the *scenes* are the tests. `mutation.ts`
generates a few weakened variants ("mutants") of the **candidate** patch — weaken
a matcher, comment an assertion out, replace it with `toBeDefined()` — and
`verify.ts` asks whether the verifier would catch each one. A mutant that would
receive the same verdict as the candidate has **survived**, which means the
verifier is blind to that kind of weakening; survivors block `PASS`.

### 3.5 Oracle strength (adequacy score)
`adequacy.ts` computes one number in `[0, 1]`:

```
score = 0.3·falsifiability + 0.3·coverage + 0.2·envCompleteness + 0.2·mutantKillRate
```
- falsifiability = falsifiable critical-path assertions / all critical-path assertions (of the *original* check)
- coverage = distinct falsifiable assertion ids named by any scene's `assertionsInvolved` / all falsifiable ids
- envCompleteness = verified env assumptions / all env assumptions
- mutantKillRate = killed mutants / all mutants (0 if no mutants)

`PASS` requires `score ≥ 0.7`.

### 3.6 Determinism, repetitions and flakiness
A reproduction is only trustworthy if it is deterministic. The bundle carries
determinism evidence (`targetRuns: 20, achieved: 20, overlapFailRate: 1,
sequentialPassRate: 1`); the **determinism gate** (PR-7) blocks `PASS` if the
reproduction was not verified for ≥ 20 runs at 100 %. Every scene is run several
times; if repetitions disagree, the scene is flaky and the observation is
`uncertain`. Healthy scenes must be repeated ≥ 5 times (PR-12) before a pass is
believed.

### 3.7 Vacuous truth — the bug this repo just fixed
`[].every(x => x.passed)` is `true`. If the check never runs, "every check
passed" is vacuously true. A verifier must therefore demand **positive evidence
of execution**: the run must prove it contacted the armed app. Today that proof
is the instrumented `fetch` trace (`simHits`); a run without it is classified
`uncertain`, never `pass`.

### 3.8 Stable assertion identity (FNV-1a)
Three parties must agree on "which assertion is this": the static scanner (sees
source text), the runtime DSL (sees values), and the manifest (names oracles by
id). `src/assertion/id.ts` hashes `matcher|target` with FNV-1a (a tiny,
non-cryptographic 32-bit hash) and prefixes `assert:`. The subject is
deliberately dropped from the key because the scanner sees `login.status`
whereas the runtime sees `200`; collisions between assertions with the same
matcher and target are accepted.

### 3.9 Sandboxing via a child process, JSON over stdout
The candidate patch is untrusted-ish code. It is run in a **separate Node
process** in a temp directory, with the DSL copied next to it, and it reports
back exactly one JSON line on stdout. The parent never imports the patch.
(Isolation here is for reproducibility and crash containment, not security.)

### 3.10 Deterministic simulation
Two ingredients make runs reproducible: the **app simulator** (a tiny HTTP server
whose behaviour is a pure function of the scene mode and request sequence), and
**seeded randomness** inside the sandbox (`Math.random` replaced by a mulberry32
PRNG seeded per scene+repetition), so even a check that flips a coin produces the
same evidence on every re-run.

### 3.11 Node-native TypeScript
There is no build step. Node ≥ 22.18 / 24 strips TypeScript types on the fly
(`erasableSyntaxOnly` in tsconfig means: no enums, no parameter properties,
`import type` for types, `.ts` extensions in import paths). `tsc --noEmit` is
used only for type-checking, `node --test` for tests.

---

## 4. Architecture

### 4.1 The pipeline

```
 --patch check.ts        --bundle incidents/<id>/
        │                        │
        ▼                        ▼
   readFileSync              bundle.ts  ──▶ Bundle {manifest, checkSource(original), appSimPath}
        │                        │
        └──────────┬─────────────┘
                   ▼
              verify.ts  (orchestrator)
   ┌───────────────┼────────────────────────────────────────────────┐
   │ 1 detectEnvScopeDodge(original, patch)            (heuristic)  │
   │ 2 buildContract(bundle, patch)      contract/contract.ts       │
   │     ├ provenance validation                                    │
   │     ├ parseInventory(original) / parseInventory(patch)         │
   │     ├ inventoryDiff → removed / weakened / added               │
   │     ├ determinism gate, unverified env assumptions             │
   │     └ suppression candidates (assertion inside try/catch)      │
   │ 3 for each scene: executor.runScene(bundle, patch, scene)      │
   │       synthetic: app-sim.drive(scene) → runSandbox × N         │
   │ 4 mutants: seedMutants(patch) → static kill or scene runs      │
   │ 5 assessAdequacy → oracle_strength                             │
   │ 6 decide(...)  decision/decision.ts  — THE LAW                 │
   │ 7 env-dodge override (PASS → FAILED)                           │
   │ 8 buildReport → markdown + json                                │
   └────────────────────────────────────────────────────────────────┘
                   ▼
            cli.ts prints report, exits 0 / 1 / 2
```

### 4.2 Why it is layered this way

- **Static before dynamic.** The contract engine can convict many fooling
  patches from source alone (removed/weakened assertion, `try/catch` around an
  assertion). It is instant and needs no app. Dynamic scenes then test what
  static analysis cannot see (does the fix actually work? does it still detect a
  real failure?).
- **An executor interface (PR-1).** `ExperimentExecutor` has two
  implementations: `SyntheticExecutor` (drives the fixture's `app-sim.ts`
  in-process and runs the check in a sandbox) and `ChecklyExecutor` (deploys
  the check to real Checkly and reads the run result). The decision table does
  not know which one produced the observations, so the synthetic proof
  transfers to production by swapping the executor.
- **One place for the verdict.** `decision.ts` is the only module that turns
  evidence into a verdict, written as an ordered list of rules ("the law"). It
  has no I/O, no randomness, no LLM import — it is the module you can grep to
  prove the tool is AI-free.
- **Everything reduces to a trace.** `SceneObservation.trace` is a list of steps
  and assertion outcomes recorded *inside the sandbox*; the report's evidence
  lines are derived from it, never inferred.

### 4.3 Process boundaries

```
 CLI process (node src/cli.ts)
 ├── app-sim HTTP server (in-process, 127.0.0.1:<random port>)
 └── for every repetition of every scene:
       spawn  node --no-warnings driver.ts   (cwd = fresh temp dir)
              env: APP_BASE_URL, ACCOUNT, CONCURRENT_RUNS, SANDBOX_SEED
              stdout: one JSON line {"__verifyFixOutcome":true, ...}
              ← child fetches http://127.0.0.1:<port>/login, /book, ...
```

Note the consequence of this layout: anything that blocks the CLI's event loop
(e.g. `spawnSync`) deadlocks the run, because the child's HTTP requests are
served by the parent.

---

## 5. Code tour — file by file

Repository layout:

```
bin/verify-fix                 executable shim → src/cli.ts
src/
  cli.ts                       argument parsing, executor selection, exit code
  verify.ts                    orchestrator (the pipeline above)
  bundle.ts                    loads manifest.json + original check + app-sim path
  types.ts                     all shared types (Bundle, Scene, SceneObservation, Decision…)
  check-api.ts                 the sandbox DSL: check(), expect(), runCollected()
  sandbox.ts                   runs a patch in a child process, parses its JSON
  contract/contract.ts         provenance + inventory diff + gates (static engine)
  assertion/id.ts              assertion identity (FNV-1a of "matcher|target")
  assertion/classify.ts        matcher → exact/property, falsifiable?
  assertion/inventory.ts       regex scanner for expect() calls, steps, try/catch guards
  adequacy/adequacy.ts         oracle_strength and weakness scan
  mutation.ts                  seeded mutants of the candidate
  decision/decision.ts         the verdict law
  report/report.ts             markdown + json report
  executor/synthetic.ts        SyntheticExecutor + AppSim interface + env-dodge heuristic
  executor/checkly.ts          ChecklyExecutor (real API; dry-run without key)
fixtures/slots-booking/
  bundle/incidents/slots-booking-overlap/{manifest.json, check/booking.check.ts, app-sim.ts}
  bundle/incidents/slots-booking-weak-oracle/…        second bundle (weak oracle)
  patches/01…11*.ts            one good fix + nine fooling vectors + one weakened good fix
test/verify.spec.ts            node:test harness (25 tests)
docs/PROJECT-GUIDE.md          this document
```

### 5.1 `src/types.ts` — the vocabulary
- `Bundle` — the parsed manifest plus `checkSource` (the original check text).
- `Scene` — `sceneId`, `type` (`REPRODUCTION | HEALTHY | DETECTION | MUTATION |
  REGRESSION`), `stateDriver` (how to put the app into the state), `verdict`
  (`mustFail`, `provenance`, `envAssumptions`), `experiments[0].repetitions`,
  `assertionsInvolved`.
- `ObservationValue = "pass" | "fail" | "uncertain"` — what an executor saw.
  `uncertain` is the third, mandatory value: no admissible evidence.
  `OracleExpectation = "pass" | "fail"` — what a scene expects (always binary).
- `SceneObservation` — `observed`, `repetitions`, `trace: TraceStep[]`,
  `source`, optional `reason` (mandatory when `uncertain`).
- `EvidenceRow` — one report row: `experiment, oracle, expected, observed,
  matched, strength, note?`.
- `Decision` — `verdict, exitCode, rows, reasons, adequacy, weakness`.
- `ExperimentExecutor` — the interface both executors implement:
  `runScene(bundle, patchSource, scene)`, `isLive()`, `costReport()`,
  `budgetExhausted`, `nondeterministicScenes`.

### 5.2 `src/bundle.ts` — loading an incident
`loadBundle(dir)` reads `manifest.json`, insists on `schemaVersion: "v2"`,
reads `check/<bundle.check.file>` into `bundle.checkSource`, and returns
`appSimPath` if `app-sim.ts` exists (null otherwise → Checkly executor).

### 5.3 `src/assertion/id.ts` — identity
```ts
assertionKey(_subject, matcher, target) = `${matcher}|${normalize(target)}`
assertionId(...) = "assert:" + fnv1a(key)   // e.g. toBe|200 → assert:157dab33
```
This file is copied verbatim into the sandbox so the runtime and the scanner
hash identically. Do not change it without regenerating manifests.

### 5.4 `src/assertion/classify.ts` — matcher table
A lookup table: `toBe/toEqual/toContainText/toHaveLength/…` are `exact` and
falsifiable; `toBeDefined/toBeTruthy/toBeGreaterThan(OrEqual)/toBeLessThan/…` are
`property` and not falsifiable. `isWeakMatcher`, `isFalsifiable(matcher, target)`
are the two predicates the rest of the code uses.

### 5.5 `src/assertion/inventory.ts` — the static scanner
- `stripComments(source)` blanks `//` and `/* */` comments while keeping every
  line break (line numbers stay stable) and respecting string/template literals
  (so `"http://…"` survives). A commented-out `expect()` is not an assertion.
- `findAssertions` runs one regex per line:
  `expect\s*\(\s*([^)\]]+?)\s*\)\.([A-Za-z][\w$]*)\s*\(\s*([\s\S]*?)\s*\)` →
  `(subject, matcher, target, lineNumber, guarded)`.
- `guardRanges` is a small brace-depth state machine that marks lines inside a
  `try { … } catch` (and the catch block itself, `.catch(`, `softExpect`,
  `expect.poll`) as **guarded** — an assertion there can throw harmlessly.
  `try/finally` without `catch` is deliberately *not* a guard (the good patch
  uses it to release the lock).
- `parseInventory(file, source)` → `{ assertions[], steps[], totalAssertions }`,
  each assertion carrying `id, subject, matcher, target, kind, falsifiable,
  guarded, sourceLine, onCriticalPath: true`.
- `inventoryDiff(original, patched)` keys assertions by `subject|matcher` and
  reports `removed` (in original, not in patch), `weakened` (was falsifiable,
  now not), `added`, `changedTarget`, `flowChanged`.

### 5.6 `src/contract/contract.ts` — the static engine
`buildContract(bundle, patchedSource)` returns a `ContractReport`:
- `provenanceViolations` — scenes whose verdict provenance is not
  `recorded`(with runId+artifactId) or `code`(with `assert:` id);
- `original` / `patched` inventories and their `diff`;
- `unverifiedAssumptions` — env assumptions with `verified: false`;
- `determinismGate` — blocked unless `achieved ≥ targetRuns`,
  `overlapFailRate === 1`, `sequentialPassRate === 1`;
- `suppressionCandidates` — patched assertions that are `guarded && exact &&
  falsifiable` (a real assertion wrapped so its failure can be swallowed);
- `rows` — one per scene with `expected` from `mustFail` and `observed:
  "uncertain"` until an executor fills it in.

### 5.7 `src/check-api.ts` — the DSL the check runs against
This file is copied into the sandbox and is what `import { check, expect }
from "./check-api.ts"` resolves to (`sandbox.remapImports` also maps
`@checkly/playwright` / `@checkly/cli` here so a real check file runs unmodified).
- `check(name, handler)` pushes into a module-level `registry`.
- `expect(actual)` returns matchers; each calls `assert(matcher, subject,
  target, ok, detail)` which records **exactly one** trace entry
  `{kind:"assertion", what, outcome, assertionId}` and throws a marked error
  (`__checkFailure = true`) when `ok` is false. `targetOf(expected)` renders the
  expected value source-like (`200`, `true`, `"CONFIRMED"`) so the runtime id
  equals the scanner's id.
- `instrumentFetch(baseUrl)` wraps `globalThis.fetch`: every request becomes a
  step `fetch POST /login → 200`; requests that reached the armed base URL and
  got a response increment `simHits`. A network error is a *failed* step and not
  a hit.
- `runCollected(ctx)`: if the registry is empty → emit a vacuous outcome with an
  explicit step `DSL did not contact armed sim: no check registered`. Otherwise
  run each registered check (`concurrentRuns` times; the executor always uses 1),
  reset `trace/simHits/assertionCount` per run, catch failures, and emit one JSON
  line: `{ __verifyFixOutcome: true, baseUrl, results[], vacuous, vacuousReason }`
  where `results[i] = { name, passed, error, trace, runCount, runs, simHits,
  assertionCount }`. `passed` is only true when `simHits > 0` and the run held.

### 5.8 `src/sandbox.ts` — running the patch in isolation
`runSandbox(checkSource, { baseUrl, account, concurrentRuns, timeoutMs, seed })`:
1. `mkdtemp(verify-fix-sandbox-*)`;
2. write `check.ts` (the patch, imports remapped), `id.ts`, `check-api.ts`
   (import path rewritten to `./id.ts`), `seed.ts` (mulberry32 PRNG installed
   as `Math.random` when `SANDBOX_SEED` is set) and `driver.ts`:
   ```ts
   import "./seed.ts";
   import "./check.ts";          // ← registers the check (this import was the missing line)
   import { runCollected } from "./check-api.ts";
   await runCollected({ baseUrl: process.env.APP_BASE_URL, account: process.env.ACCOUNT, concurrentRuns });
   ```
3. `spawn(process.execPath, ["--no-warnings", "driver.ts"])` with env
   `APP_BASE_URL, ACCOUNT, CONCURRENT_RUNS, SANDBOX_SEED`; 20 s timeout → kill;
   non-zero exit → throw (the executor turns that into `uncertain`);
4. `parseOutcomeLine(stdout)` finds the last line containing
   `"__verifyFixOutcome":true` (so a check that prints JSON cannot spoof it);
5. returns `{ passed, vacuous, vacuousReason, results, simHits, raw }` with
   `passed = !vacuous && every result passed`;
6. always removes the temp dir.

### 5.9 `src/executor/synthetic.ts` — the synthetic executor
- `AppSim` interface: `start(): Promise<baseUrl>`, `drive(scene)`, `close()` —
  the contract the fixture's `app-sim.ts` implements.
- `SyntheticExecutor.runScene(bundle, patch, scene)`:
  1. budget: `budgetFor(bundle) = option ?? bundle.runBudget.maxPerScene ?? 10`;
     if this scene's runs are exhausted → `uncertain("run budget exhausted")`
     and `budgetExhausted = true`;
  2. `ensureSim()` imports `app-sim.ts` once and starts it; `sim.drive(scene)`
     arms the mode (`normal | overlap | auth-fail`) and clears account state;
  3. repeat `min(scene.repetitions, budget)` times: `runSandbox(patch, {baseUrl,
     account, seed: repetitionSeed(sceneId, i)})` — REGRESSION scenes use account
     `demo-r<i>` (an independent user); a sandbox exception → `uncertain("sandbox
     could not run the check: …")`; a `vacuous` outcome → `uncertain("DSL did not
     contact armed sim…")`; otherwise record `pass`/`fail` and merge the trace;
  4. repetitions disagree → `nondeterministicScenes.push(id)` and
     `uncertain("repetitions disagreed (pass×a, fail×b)")`;
  5. otherwise `{ observed, repetitions, trace, source:"synthetic" }`.
- `detectEnvScopeDodge(original, patched)` — regex heuristic: any
  credential-bearing line (`account:`, `ACCOUNT =`, `username`, `email`, …) that
  uses `Date.now()/Math.random()/randomUUID()` ⇒ "generated at runtime"; else the
  **set** of distinct credential statements must be unchanged ⇒ otherwise
  "constant changed".

### 5.10 `src/executor/checkly.ts` — the production executor
Same interface against Checkly's API: `PUT /v1/check-checks/<id>` (deploy the
patched script with env `APP_BASE_URL`, `APP_SCENE`), `POST …/runs`, `GET
/v1/check-results/<id>` → `successful` → pass/fail, with the result's assertion
list mapped into the trace. Without `CHECKLY_API_KEY` (or with `--dry-run`) it
only logs the operations and reports every scene `uncertain` ("no live run was
performed"). The route shapes have not been exercised against a live account.

### 5.11 `src/mutation.ts` — seeded mutants
`seedMutants(patch, file)` takes the falsifiable `exact` assertions of the
candidate and builds up to four mutants:
- `mut-op-<id>` (operator family) for the first and second strong assertion:
  `toBe(<number|bool>)` → `toBeGreaterThanOrEqual(0)`; text matchers →
  `toBeDefined()`;
- `mut-llm-<id>` (contextual family): the assertion line commented out;
- `mut-llm-dodge-<id>`: every `expect(subject).matcher` line replaced by
  `await expect(subject).toBeDefined();`.
Each mutant is a full alternative source text.

### 5.12 `src/adequacy/adequacy.ts` — oracle strength
Computes the four factors of §3.5, the `WeaknessScan` (`insufficientInputSpace`,
`partialPathCoverage`, `weakAssertions[]`, `missingEnvContext[]`, mutant names)
and human-readable `blockers`. Pure function of contract + observations + mutant
results.

### 5.13 `src/decision/decision.ts` — the law
`decide({contract, observations, adequacy, nonDeterministicScenes,
healthyRepetitionsMet, runBudgetExhausted})`, in this exact order:

1. provenance violations → `UNCERTAIN` ("bundle rejected at ingestion").
2. Build rows: `observed = observations.get(scene)?.observed ?? "uncertain"`;
   `matched = observed !== "uncertain" && observed === expected`.
3. Record reasons (no return yet): determinism gate blocked; non-deterministic
   scenes.
4. Any **mismatch** (a real pass/fail different from expected) → `FAILED`.
5. Any **core-path assertion removed or weakened** → `FAILED`.
6. Any **suppression candidate** → `FAILED`.
7. Any **uncertain** row → `UNCERTAIN` with the executor's reason
   ("no admissible observation … never PASS").
8. Any **surviving mutant** → `UNCERTAIN` if `score < 0.7` (blind spot) else
   `FAILED` ("weakening caught").
9. Run budget exhausted → `UNCERTAIN` (PR-10).
10. Determinism gate blocked → `UNCERTAIN`.
11. Non-deterministic scenes → `UNCERTAIN`.
12. `PASS` only if all of: `score ≥ 0.7`; ≥ 2 independent scene types (PR-6);
    ≤ 1 weak-assertion hit on the core path; all env assumptions verified;
    ≥ 3 scenes; no regression mismatch; healthy scenes repeated ≥ 5 (PR-12).
    Otherwise `UNCERTAIN` ("mandatory PASS conditions not all met").

Then, back in `verify.ts`, an env-scope dodge downgrades a `PASS` to `FAILED`.

Conclusive evidence of a bad patch (4–6) always beats "we could not observe"
(7), and nothing after 7 can turn missing evidence into a pass.

### 5.14 `src/verify.ts` — the orchestrator
Exactly the pipeline of §4.1. Two details worth knowing:
- `nonDet` (flaky scenes) is snapshotted **after the candidate's scenes and
  before the mutation phase**, so a mutant's behaviour cannot pollute the
  candidate's determinism evidence.
- Mutation kill rule: `staticallyRejected(bundle, mutant)` first (the same
  static law that fails a candidate: removed/weakened core-path assertion or a
  suppression candidate). Only if the static engine cannot tell are the
  DETECTION and HEALTHY scenes run for the mutant; `detObs.observed === "pass"`
  (masked a must-fail) or `healthyObs.observed === "fail"` (broke healthy)
  counts as a kill; `uncertain` never counts.

### 5.15 `src/report/report.ts`
Builds the markdown (`# verify-fix report — <incident>`, verdict, table,
adequacy, reasons, top-5 evidence lines) and the JSON (`incidentId, verdict,
exitCode, rows, adequacy, reasons, determinism, topEvidence`). Uncertain rows
print `?` in the match column and an `INCONCLUSIVE: <reason>` evidence line.

### 5.16 `src/cli.ts` and `bin/verify-fix`
`verify-fix verify --patch <file> --bundle <dir> [--executor synthetic|checkly|auto]
[--dry-run] [--json] [--verbose]`. `auto` picks synthetic when the bundle has an
`app-sim.ts`, else Checkly. `--executor synthetic` without an app-sim is a clean
error (exit 2). `--verbose` streams per-run lines to stderr
(`[synthetic] scene=… run=1/5 observed=fail expected=fail simHits=4`) and the
mutant kill lines. The process exit code is the verdict's code.

### 5.17 The fixture

`manifest.json` — schema v2, incident text, `check {repo, file, logicalId}`,
the five scenes (§2.2) with `verdict.provenance = {kind:"code", assertionId}`
and `assertionsInvolved`, two verified env assumptions
(`account-single-shared`, `session-single-per-account`), determinism evidence
(20/20, rates 1), `runBudget.maxPerScene: 40`.

`check/booking.check.ts` — the original check (login → book → three
assertions on the booking).

`app-sim.ts` — `export default async function create(): Promise<AppSim>`.
State: `mode` and a `Map<account, {version, lockHolders}>`. Endpoints:
- `POST /login {account}` → `version += 1`, token `tok-<account>-<version>`.
  In `overlap` mode **and** when nobody holds the lock, the version is bumped a
  second time (the phantom overlapping run) and the response carries
  `superseded: true` — our token is already stale.
- `POST /lock {account}` → `lockHolders += 1`, then waits (polling every 2 ms)
  until `lockHolders === 1`; `POST /unlock` decrements. This is the primitive a
  serialization fix uses.
- `POST /book` with `Authorization: Bearer tok-<account>-<version>` → in
  `auth-fail` mode always `401`; otherwise parse the token, look up the account,
  `200 {confirmed:true, booking:"CONFIRMED"}` iff the version matches, else
  `401 session superseded`.
- `drive(scene)` sets `mode` from `scene.stateDriver.params.mode` and clears all
  accounts.

`patches/` — see §1.3; `02-mutation-d-weakened-good.ts` is the good fix with
`expect(book.status).toBe(200)` weakened to `toBeGreaterThanOrEqual(0)` (must be
caught).

### 5.18 `test/verify.spec.ts`
25 `node:test` tests in five groups: the sandbox evidence rule (empty registry,
hitless check, trace ids bind to inventory ids, one entry per failed assertion,
outcome-marker parsing, seeded randomness); executor classification (vacuous /
other host / crash / budget); static engine (env-dodge, comment stripping);
decision table (uncertain → 2, mismatch still wins, unobserved scene is not a
pass); and the seeded suite (01 → PASS with scene-c `fail`, identical rows on
re-run; 02–10 → exit 1; 11 → never PASS and reproducible; CLI exit code).

---

## 6. How the parts communicate

| from → to | mechanism | payload |
|---|---|---|
| CLI → verify | function call | `{bundle, patchSource, executor, verbose}` |
| verify → contract/adequacy/decision/report | pure function calls | `Bundle`, source strings, `Map<sceneId, SceneObservation>` |
| verify → executor | `runScene(bundle, patch, scene)` (interface) | returns `SceneObservation` |
| executor → app-sim | dynamic `import()` + `start/drive/close` | `Scene` object |
| executor → sandbox | `runSandbox(source, ctx)` | writes files to a temp dir |
| sandbox → child | `spawn` + environment variables | `APP_BASE_URL, ACCOUNT, CONCURRENT_RUNS, SANDBOX_SEED` |
| child → app-sim | HTTP over loopback | `/lock /login /book /unlock` |
| child → sandbox | stdout, one marked JSON line | `CollectedOutcome` |
| decision → CLI | `Decision.exitCode` | `process.exit(0|1|2)` |

Two invariants tie it together: the assertion id computed in the child equals
the id the scanner computes in the parent (same `id.ts` bytes), and the child's
trace is copied verbatim into the observation and from there into the report.

---

## 7. Setting up and running

Requirements: Node ≥ 22.18 (or 24, as `package.json` declares) — type stripping
must be available; no runtime dependencies. Dev dependencies (`typescript`,
`@types/node`) are only for `npm run typecheck`.

```bash
npm ci                       # dev deps for type-checking (optional for running)

# verify the good patch
node --no-warnings src/cli.ts verify \
  --patch fixtures/slots-booking/patches/01-good-serialize.ts \
  --bundle fixtures/slots-booking/bundle/incidents/slots-booking-overlap \
  --executor synthetic
echo $?                      # 0

# machine-readable, and see every run
node --no-warnings src/cli.ts verify --patch … --bundle … --executor synthetic --json --verbose

# the whole seeded suite
for p in fixtures/slots-booking/patches/*.ts; do
  node --no-warnings src/cli.ts verify --patch "$p" --bundle fixtures/slots-booking/bundle/incidents/slots-booking-overlap --executor synthetic >/dev/null 2>&1
  echo "exit=$? $(basename "$p")"
done

npm test                     # 25 tests, ~50 s (runs real sandboxes)
npm run typecheck            # tsc --noEmit
```

`--no-warnings` only hides Node's "type stripping is experimental" banner.
A single verification of the good patch costs 17 sandbox processes (3+5+2+5+2
repetitions) and takes about 4–5 s.

Reading the report: look at the `match` column first (`✗` = conclusive
mismatch, `?` = no admissible evidence), then **Reasons** — the first reason is
the rule that decided the verdict.

---

## 8. Step by step: what happens when you verify the good patch

1. `cli.ts` parses arguments, reads the patch text, `loadBundle()` reads the
   manifest and the original check, finds `app-sim.ts` → `SyntheticExecutor`.
2. `verify()` runs `detectEnvScopeDodge` → `null` (the good patch reuses the
   same `account: ACCOUNT` statements, just in more requests).
3. `buildContract`: provenance OK (all `code:assert:*`); original inventory = 4
   falsifiable `toBe` assertions (`157dab33` ×2, `3b894637`, `4ed3ff52`); patch
   inventory = the same 4 → nothing removed/weakened; determinism gate passed;
   no unverified assumptions; no suppression candidates (`try/finally` is not a
   guard).
4. Scenes, in manifest order. For `scene-a-overlap` (3 reps): `drive` → mode
   `overlap`; each rep spawns a sandbox. Inside: `/lock` (holder count 1) →
   `/login` (lock held ⇒ no phantom bump; token `tok-demo-1`) → `/book` (version
   matches ⇒ 200) → assertions hold → `/unlock`. `simHits = 4`, `passed`. Three
   identical outcomes ⇒ `observed: "pass"`.
5. `scene-b-single-run` (5 × normal) → pass; `scene-a-prime` (2 × overlap) →
   pass.
6. `scene-c-auth-failure` (5 × auth-fail). The trace of one repetition:
   ```
   fetch POST /lock → 200
   fetch POST /login → 200
   toBe(200) on num(200) — match            assert:157dab33  ok
   fetch POST /book → 401
   toBe(200) on num(401) — got num(401)     assert:157dab33  failed
   fetch POST /unlock → 200
   ```
   ⇒ `observed: "fail"` — exactly what the DETECTION oracle demands.
7. `scene-e-regression` (2 × normal, accounts `demo-r0`, `demo-r1`) → pass.
8. Mutants of the good patch: `strong[0]` = `expect(login.status).toBe(200)`,
   `strong[1]` = `expect(book.status).toBe(200)`. All four mutants are
   statically rejected (each removes/weakens a core-path assertion) ⇒ killed,
   zero extra sandbox runs.
9. `assessAdequacy`: falsifiability 1.0, coverage 0.0 (see §10.4), env 1.0,
   kill rate 1.0 ⇒ `score = 0.7`.
10. `decide`: no mismatch, nothing removed, no suppression, no uncertain rows,
    no survivors, budget fine, deterministic; PASS conditions: 0.7 ≥ 0.7 ✓,
    types {REPRODUCTION, HEALTHY, DETECTION, REGRESSION} ✓, weak hits 0 ✓, env ✓,
    5 scenes ✓, no regression mismatch ✓, healthy reps 5 ✓ ⇒ **PASS**.
11. No env dodge ⇒ verdict stands; sim closed; report printed; `exit 0`.

### How each fooling seed is convicted (all deterministic)

| patch | first rule that fires |
|---|---|
| 02 weakened good | rule 5: core-path assertion weakened/removed (`book.status.toBe`) |
| 03 weaken assertion | rule 4: scene-a/a′ mismatch (no lock ⇒ overlap still 401) |
| 04 catch/ignore | rule 4: scene-c observed **pass** where it must fail |
| 05 trivially true | rule 4: overlap scenes mismatch (and static weakening) |
| 06 hardcode | rule 4: scene-c observed pass (constants always match) |
| 07 change account | rule 4: overlap mismatch; env-dodge would also downgrade |
| 08 timeout mask | rule 4: scene-c observed pass after retries |
| 09 remove step | rule 4: scene-c observed pass (nothing left to fail) |
| 10 symptom-only | rule 4: overlap mismatch; regression scene also fails |
| 11 flaky | rule 4 (scene-a′ failed on both seeded reps) with flakiness recorded in the reasons ⇒ FAILED, never PASS |

---

## 9. Where it works, where it does not, and its limitations

### 9.1 Works
- Linux/macOS with Node ≥ 22.18/24, no network needed (loopback only).
- Checks written as `fetch`-based flows against the DSL (`check`/`expect`
  imported from `./check-api.ts`, `@checkly/playwright` or `@checkly/cli`).
- Bundles with an `app-sim.ts` implementing `AppSim`.

### 9.2 Does not (yet) work / untested
- **Browser checks.** There is no Playwright in the sandbox; `page.goto`,
  `page.click` do not exist, and only `fetch` is instrumented as "contact with
  the app". A real Checkly browser check would crash (⇒ `uncertain`).
- **Live Checkly executor.** Route shapes are unverified against the real API;
  only dry-run behaviour is exercised.
- **Windows** is untested (paths, `process.execPath`, temp dirs should work in
  principle).
- **Concurrent runs inside one sandbox** (`concurrentRuns > 1`) share one
  module-level trace; the executor never uses it (overlap is expressed by the
  simulator's state instead).

### 9.3 Design limitations to be honest about
1. **The scanner is regex-based.** Multi-line `expect(` calls, subjects
   containing `)` or `]` (`expect(foo(1))`, `expect(arr[0])`), and unusual
   formatting are missed; the try/catch guard detection is a heuristic; the
   env-dodge check is a heuristic on lines mentioning `account`/`email`/… .
2. **Assertion identity drops the subject.** `login.status toBe 200` and
   `book.status toBe 200` share id `assert:157dab33`; the manifest cannot
   distinguish them.
3. **Stale manifest ids ⇒ coverage 0.00.** The manifest's
   `assertionsInvolved`/provenance ids (`55fcc552`, `a8a58d76`, `f460baf9`,
   `43cb9d60`) were generated under an older `subject|matcher|target` scheme and
   bind to nothing under the current `matcher|target` scheme. The good patch
   therefore passes with strength exactly 0.700. Regenerating them (with the
   collision above) would lift strength to 1.0.
4. **Mutation kill rate is now mostly static.** Because the seeded mutant
   families always remove/weaken an assertion, the contract engine kills them
   all; the dynamic part only matters for mutants static analysis cannot see.
5. **Flakiness detection power is bounded by repetitions** (3/2/5 here), and the
   law puts *mismatch* before the *flake gate*: a flaky patch that happens to
   fail every repetition of one scene is `FAILED`, not `UNCERTAIN`. With seeded
   randomness this is at least reproducible.
6. **The sandbox is not a security boundary.** The child inherits the
   environment, network and filesystem; it isolates for reproducibility only.
7. **Trust in the bundle.** Determinism numbers and `verified: true` on env
   assumptions are taken at face value.
8. **The second fixture** (`slots-booking-weak-oracle`) is meant to show that a
   weak oracle caps at UNCERTAIN, but its `patches/good.ts` also drops an
   assertion, so the static law fails it (exit 1) — a fixture inconsistency,
   unchanged by the recent fix.

---

## 9b. The `bundle` command — capturing an incident from Checkly (Phase 1)

Everything above grades a patch against a bundle that was written by hand.
The redesign (docs/BRAINSTORM.md, docs/PLAN.md) replaces the hand-written
bundle with one the tool records from the customer's real Checkly account:

```bash
export CHECKLY_API_KEY=cu_...  CHECKLY_ACCOUNT_ID=...     # or: npx checkly login (the tool reads the CLI's saved login)
verify-fix bundle --check <checkId> --out ./bundle --project examples/slots-booking/web
```

### Input

- the **check id** (`npx checkly checks list` or the dashboard URL);
- optionally `--result <id>` to pick the failing run (default: newest failed
  `FINAL` result); `--project <dir>` pointing at the project that deployed the
  check (for the example: the app folder itself, `examples/slots-booking/web`,
  which holds `checkly.config.ts`, `playwright.config.ts` and `tests/`), so
  the spec source can be copied; `--measure N` to run
  the check N times sequentially and `--measure-overlap M` to run M copies at
  once through `npx checkly test --record` (the CLI must be installed in the
  project); `--trigger-rca` to request a Rocky analysis when none exists;
  `--bodies api|all|none` (default `api`: keep API bodies, drop static assets);
  `--history N` (default 100 results for the pass-rate table); `--json`.
- credentials only from the environment or the Checkly CLI's login files
  (`~/Library/Preferences/@checkly/cli/auth.json` + `config.json` on macOS,
  `~/.config/@checkly/cli/` on Linux). No flag takes a key; nothing is stored.

### Data flow

1. `GET /v1/checks/{id}` → type, locations, `runParallel`, retry strategy, env
   var **names** (values are dropped immediately), Playwright config path.
2. `GET /v2/check-results/{id}?resultType=FINAL&limit=…` → history. The
   failing run = newest with `hasFailures`; the passing run = newest passing
   result **before** it (so the healthy oracle predates the incident).
3. For both: `GET /v1/check-results/{id}/{resultId}` + `…/assets?type=trace`,
   then the trace zip is downloaded from the presigned URL — **without** the
   auth headers (they are attached only to `api.checklyhq.com`).
4. `src/trace/trace-to-har.ts`: the Playwright trace zip is parsed in memory
   (`src/trace/zip.ts`, STORE + DEFLATE): `*.network` lines become HAR 1.2
   entries, bodies are inlined from `resources/<sha1>`, `*.trace`
   before/after events become an action list with the failing step and its
   error message. Traces from several files (one per test) are merged by time.
5. `src/bundle/sanitize.ts`: authorization/cookie/set-cookie/api-key headers,
   secret-looking query params and JSON fields (`token`, `password`,
   `secret`, `authorization`, …) are replaced by `REDACTED(<fnv1a>)` — same
   input → same tag, so two runs stay comparable while the value is gone.
6. Error group (`GET /v1/error-groups/{id}` from the result's
   `errorGroupIds`) and Rocky RCA (`rootCauseAnalyses[0]`, or
   `POST /v1/root-cause-analyses/error-groups/{id}` with `--trigger-rca`,
   polled while it answers 202).
7. `src/bundle/rca-mode.ts` maps the RCA text to a REPRODUCTION mode with a
   fixed rule table (no model in the loop): race / parallel / session-superseded
   → `live-concurrent:2`; selector / changed response / status code → 
   `replay:failing.har`; no match → `both` (primary live-concurrent, alternative
   replay). The matched rule and text are recorded so anyone can audit the choice.
8. `src/bundle/manifest.ts` (pure function) builds `manifest.json` v3:
   incident, check facts, target resolution (`code` when the spec reads
   `ENVIRONMENT_URL`, `handlebars` for `{{ENVIRONMENT_URL}}` in API checks,
   else `unknown`), the failure point (last failed same-origin API call in the
   failing trace, with the status the passing run got), three scenes —
   `healthy-live` (`live`, must pass, provenance = passing result id),
   `reproduction` (RCA mode, must pass, provenance = failing result id),
   `detection` (`inject:<METHOD path -> status>`, must fail) — the assertion
   inventory of the real spec (`src/assertion/inventory.ts` now reads nested
   subjects such as `expect(page.getByTestId('x'))`), environment assumptions
   (locations, `runParallel`, shared `TEST_USER`), determinism from history and
   from `--measure`, and provenance (hashed account id, result ids, asset
   sha256, every API call made).
9. `src/bundle/build.ts` writes the directory after a last guard: if any file
   would contain an env var value longer than seven characters, the build
   refuses to write.

### Output

```
bundle/
├── manifest.json            v3 — scenes, modes, provenance, failure point, determinism
├── check.config.json        check facts as deployed (env var names only) + target resolution
├── check/                   copied sources: checkly.config.ts, playwright.config.ts, tests/*.spec.ts
├── recordings/failing.har   sanitized HAR of the failing run  (+ failing.actions.json)
├── recordings/passing.har   sanitized HAR of the passing run  (+ passing.actions.json)
├── results/{failing,passing}.json   the raw Checkly result documents (env values stripped)
├── rca.json                 error group + Rocky RCA as returned
├── README.md                human summary: scenes table, determinism, notes
└── .gitignore               raw/ (only with --keep-raw)
```

The bundle is consumed by `verify` from Phase 3 on; today `verify` refuses
v3 with a clear message. The only fields a person may still edit by hand are
noted in the README of the bundle; every scene carries the result id it came
from, so nothing in it has to be trusted on faith.

### Files

`src/checkly/{client,credentials,types}.ts`, `src/trace/{zip,har-types,trace-to-har}.ts`,
`src/bundle/{build,manifest,measure,rca-mode,sanitize,types}.ts`, CLI in `src/cli.ts`;
tests in `test/bundle/*.spec.ts` with a real ZIP writer and a fake Checkly served
over local HTTP (`test/bundle/cli-http.spec.ts`).

## 9c. The scene layer — Phase 3 (replaces the simulator)

Sections 4–8 describe the tool as it was when the guide was written: a
hand-written `app-sim.ts` per bundle, driven by a "synthetic executor". Phase 3
removed that. Read those sections for the static engine, the DSL, the
sandbox, the decision law and the report — they are unchanged — and read this
section for how a scene is run now.

**What runs the check now.** `src/executor/scene.ts` (`SceneExecutor`, kind
`scene`). For every scene it arms `src/scene/proxy.ts` and starts one sandbox
per concurrent run. The check talks to `ENVIRONMENT_URL`; that is the proxy.
The proxy forwards to the real target (`--target`), answers from a recording,
or injects one failure. Nothing models the app any more; the target is the
customer's app (locally `next start` of `examples/slots-booking/web`, or a
staging URL).

**The four modes** (`src/scene/modes.ts`, written into each scene's `mode`):

| mode | what the proxy does | needs `--target` |
| --- | --- | --- |
| `live` | forwards every request | yes |
| `live-concurrent:N` | N runs at once, interleaved request by request: request k of every run is held until all runs sent theirs, then forwarded in run order, responses released together (login, login, book, book) | yes |
| `inject:<METHOD> <path> -> <status>` | forwards everything except the matching request, which gets the failing recording's response for that path and status (or a plain JSON failure) | yes |
| `replay:<file>.har` | answers from the recording in order; unmatched → 404 counted as `unmatched` | no for a complete HAR; browser HARs captured with `--bodies api` need an explicit target for omitted page assets |

For a Playwright replay whose HAR keeps API bodies only, the proxy serves API
responses from the recording and serves documents/scripts/styles from the
explicit `--target`. The report labels both sources. A complete `--bodies all`
HAR stays offline. With no target and missing asset bodies, the scene is
UNCERTAIN rather than a false browser failure.

`inject:<failing request unknown>` (written by `bundle` when nothing can be
derived) runs as `uncertain`.

**Concurrency follows the config.** A `live-concurrent:2` scene runs at
`min(2, effectiveConcurrency(patched config))`, where effective concurrency is
the number of locations when `runParallel` is true, else 1. That is how a
config-only fix (`runParallel: false`, or one location) is verified: the scene
runs at the overlap the new schedule still allows.

**Evidence gate.** The proxy counts hits per run outside the sandbox. A run
with zero hits, a vacuous run, a sandbox crash, a missing target, an unrunnable
mode or disagreeing repetitions is `uncertain` — never pass, never fail.

**Environment** (`src/scene/env.ts`): the sandbox receives only `PATH`,
`HOME`, `ENVIRONMENT_URL`, `ENVIRONMENT_NAME` (`--env-name`, default
`verify-fix`), the variables from `--env-file` (KEY=VALUE, like `checkly test
--env-file`) and the scene's own `env` (the regression scene uses
`ACCOUNT=other`). A check that reads `{{VAR}}` or `process.env.VAR` without a
fallback and without a provided value makes every scene `uncertain`, with the
line number. `APP_BASE_URL` no longer exists.

**Patches** (`src/patch.ts`): `--patch <file>` replaces the bundle's main
check file; `--patch <dir>` replaces every bundle file with the same relative
path (spec, `checkly.config.ts`, both). `src/scene/config-diff.ts` compares
the two configs: scheduling keys are allowed and noted; a change that touches
only `retryStrategy` / `doubleCheck` / timeouts is rejected as masking (retries
next to a real change are only flagged, because the runner does not simulate
retries); new `environmentVariables` keys are "declared" — they must exist in
Checkly and be given through `--env-file` to run here.

**Report.** Every row has an `environment` column: `target <host> (live)`,
`target <host> (live-concurrent:2)`, `target <host> + inject …`, or
`recording <file>`; a note under the table says which host the live rows
ran against and that they prove nothing about any other host.

**Seeded suite after the migration.** `fixtures/slots-booking/patches/`:
`01-good-run-parallel-false/` and `12-good-one-location/` PASS (config
patches, check unchanged); `02` (weakened twin of 01) and `03`–`10` FAILED;
`11-flaky` never PASS; `13-config-retry-only/` FAILED by the config policy.
The old lock-based good patch is gone: the real app has no `/lock` route, and
Checkly's own answer to "one run at a time" is scheduling, not a lock.
`test/helpers/example-app.ts` builds (if needed) and starts the example app for
the tests; the suite runs in about one minute.

**Bundle side (3.7).** A drift incident has no failing request. The bundle
command now derives the detection scene from the passing run's timeline: the
last API call before the failing step (Playwright's monotonic clock on actions
and HAR entries) is the step's dependency, and the scene injects a 500 on it.
When every run since the last passing one failed in every location, the
reproduction mode is `live` (`decidedBy: history`). Phase 4 rebuilt the
committed drift manifest from its retained HAR, actions and result history, so
it now contains `live` and `inject:POST /api/book -> 500` directly.

## 9d. The Playwright runner — Phase 4

**Selection.** A bundle whose main check is a `.spec.ts` or `.test.ts` file and
whose manifest names a Playwright config uses `src/playwright-sandbox.ts`.
DSL checks still use `src/sandbox.ts`.

**Files and dependency.** The runner creates a temporary directory. It copies
every captured file under `check/`, then overlays every candidate file. This
lets a patch replace the spec, `checkly.config.ts`, or a helper. It resolves
`@playwright/test` from `--project <dir>` and links that project's
`node_modules`; the tool does not download a second Playwright version.

**Process.** The runner starts the official Playwright CLI with the captured
`playwright.config.ts`, its recorded projects, `--workers=1`, `--retries=0`
and `--reporter=json`. It passes only the explicit check variables plus
`ENVIRONMENT_URL` and `ENVIRONMENT_NAME`. A deterministic seed is loaded
before the config and spec, so repeated flaky candidates give the same result
on the next verify-fix invocation.

**Evidence.** Exit 1 plus a JSON report containing a failed test is a real
failure observation. A missing report, zero tests, skipped/interrupted tests,
a missing Playwright install, or a runner crash is inconclusive. The scene
executor then applies its independent proxy-hit gate. Therefore a browser
process cannot pass a scene unless a test ran and a request reached that
scene's proxy.

**Browser concurrency.** HTML, scripts, styles, images and Next.js RSC
navigation bypass the lockstep barrier because their order can differ between
browsers. API/fetch traffic enters it. Two browser runs therefore reach the
app as login, login, slots, slots, book, book. In the measured overlap bundle,
the first booking returned 401 and the second returned 200 in all 20 pairs.
Inject and replay remain in the proxy; the Playwright spec contains no
`page.route` code.

**Locator repairs.** Assertion identity is unchanged: it is still the hash of
`matcher|target`. A locator rename with the same exact matcher and target is
allowed to reach the browser scenes. A matcher change, assertion deletion, or
try/catch remains a static failure. Duplicate assertion ids are counted, so
deleting one of two `toHaveText('200')` checks is still detected.

**Local measurement.** `verify-fix measure --bundle <dir> --target <url>
--project <dir> --runs 20` runs the original captured spec through the same
proxy and writes `determinism.method: local-runner`. A concurrency incident
needs a 100% healthy one-at-a-time API baseline and a 100% failing overlap. A
persistent `live` drift incident needs the original stale check to fail 100%;
it does not need a meaningless overlap number.

**Real results.** `fixtures/patches/slots-booking-overlap/` contains the 13
Phase 4 candidates plus the Phase 5 per-location-user candidate.
`runParallel:false`, one location, and per-location users PASS. Candidates
02–10 and 13 FAILED. Candidate 11 produced mixed repetitions and was
UNCERTAIN, never PASS. `fixtures/patches/slots-booking-drift/` contains the
correct rename plus four fakes. The rename PASSed. All four fakes FAILED.
These were run with Chromium against the local `next start` app. A real
Playwright replay also passed with recorded API responses plus local page
assets. Vercel was not contacted.

## 9e. The live gate — Phase 5

**Hybrid execution.** `src/executor/hybrid.ts` routes REPRODUCTION and
DETECTION to the Phase 4 scene proxy. It routes HEALTHY and REGRESSION to
`src/executor/checkly-cli.ts`. The remote executor builds a clean temporary
project from dependency metadata plus candidate monitoring files. It invokes
the customer's own `node_modules/.bin/checkly`. It runs
`checkly test --record --reporter json --retries 0` once per required
repetition and configured location. It never changes a deployed monitor. The
old direct-API executor cannot be selected by
the `verify` command.

**Remote evidence.** Current Checkly JSON output is a file with
`testSessionId`, `numChecks`, `runLocation`, and `checks[]`. A completed Pass or
Fail is evidence. No session id, zero checks, an incomplete report, an unknown
status, a CLI crash, or any retry is UNCERTAIN. Reports keep every session id
and result id. Runtime values go only to the CLI child process and a mode-0600
temporary dotenv file outside the copied project. The file is deleted with the
sandbox.

**Cheap evidence first.** Static rejection runs before any browser. Candidate
scenes then run in this order: reproduction, detection, healthy, regression. A
local mismatch fixes the verdict at FAILED. Missing local evidence fixes it at
UNCERTAIN. In either case the verifier skips paid cloud work. A mutation that
is killed by detection also skips its remote healthy run. The decision table
is unchanged.

**Candidate project.** Phase 6 replaces this Phase 5 reader in production.
`--candidate-project <dir> --base <git-ref>` now snapshots the complete Git
working state first. The monitoring runner receives the final check/config tree
and its real relative imports. The application source is tested through the
exact deployment named by `--target`. Fixture tests can still use `--patch`.

**Regional users.** Local concurrent runs receive the candidate config's
`CHECKLY_REGION` values. A code repair may map every configured region to one
stable declared `TEST_USER_<REGION>` variable. Partial mappings, duplicate
runtime values, hard-coded replacement users, and random users remain failures.
The values come only from `--env-file` or Checkly.

**CI.** `.github/workflows/gate.yml` starts on a successful deployment status.
Phase 6 splits it into a secret-free preflight and an approved cloud job. The
workflow, verifier, incident bundle, and policy come from the protected default
branch. The candidate has a separate checkout. A protected GitHub environment
must approve cloud credentials. A fork needs that approval plus an explicit
fork flag. JSON and Markdown reports are uploaded.

The production job accepts only the current `main` commit. It verifies the
production deployment first. Only then does the workflow run `npx checkly
deploy --force`. The verify-fix process itself never deploys or provisions
anything.

**Cost.** Each report contains candidate identity, verdict, Checkly test
sessions, cloud check runs, local runs, browser processes, mutation runs, total
runs, per-scene wall time, and total wall time.
`verify-fix cost-report --reports <dir>` builds a candidate table and totals
grouped by PASS, FAILED, and UNCERTAIN. It does not guess money because account
pricing is not captured evidence.

**Distribution boundary.** The example app remains in this repository because
real CLI projects commonly keep examples plus end-to-end fixtures beside the
tool. It is not part of the npm artifact. `npm pack` now builds JavaScript under
`dist/`; the tarball contains the executable, compiled CLI, and only the two
TypeScript templates needed by the DSL sandbox. A package integration test
installs that tarball in a temporary customer project outside this repository.
It first grades a bad external candidate as FAILED. It then runs the complete
hybrid path against a customer-named `customer-staging` target and grades the
good repair as PASS. The target is a generic HTTP origin, not Vercel. The test
uses fake project-local Playwright and Checkly CLIs for process boundaries, so
it spends no cloud runs. The package remains `private: true`; publishing and a
stable package name are separate release decisions.

**Local Phase 5 results.** The source check now uses `booking-status`. Real
Chromium against `next start` gave PASS for the drift repair with 15 browser
runs. The `runParallel:false` config repair gave PASS with 15 browser runs. The
strict per-location user repair gave PASS with 20 browser runs after its final
source change. The Upstash-compatible session-lease app candidate gave PASS
with 20 browser runs. Candidates 02–10 and 13 all returned FAILED.
Candidate 11 returned UNCERTAIN.

## 9f. Complete candidate revisions — Phase 6

### Purpose

A repair is a complete final repository state. It is not one file and it is not
an agent's description of a patch. Application code, monitoring code,
configuration, helpers, package manifests, and lockfiles may all change.

### Inputs

Local work uses:

```bash
verify-fix verify \
  --candidate-project examples/slots-booking/web \
  --base origin/main \
  --bundle /protected/incidents/booking-drift \
  --target https://preview.example.com \
  --project examples/slots-booking/web
```

A pull request uses:

```bash
verify-fix verify \
  --pr https://github.com/OWNER/REPO/pull/123 \
  --project-path examples/slots-booking/web \
  --project ./candidate-runtime/examples/slots-booking/web \
  --bundle ./trusted/incidents/booking-drift \
  --target https://preview.example.com \
  --target-revision <exact-pr-head-sha> \
  --target-metadata "$RUNNER_TEMP/deployment.json" \
  --cloud-approved \
  --executor hybrid
```

`--project-path` is the Checkly project path inside the candidate repository.
`--project` is a dependency directory prepared by the caller. verify-fix never
runs `npm install`, package lifecycle scripts, browser installation, or cloud
provisioning. `--patch` remains only for fixtures and small manual experiments.

### Input to snapshot

`src/candidate/revision.ts` asks Git for the repository root. Local mode resolves
`--base` and the current `HEAD`. It lists all tracked files plus non-ignored
untracked files. That includes staged and unstaged content and preserves
renames and deletions. It copies the final files into one temporary repository.

PR mode accepts only a canonical `https://github.com/.../pull/<number>` URL. It
uses the authenticated `gh` client from the user's environment to read the base
SHA and head SHA. It fetches the exact GitHub pull ref. It rejects the run if
the fetched commit is not the head resolved at the start. It checks the PR head
again after verification. A moving PR needs a new run.

The snapshot excludes `.git`, dependencies, build output, and ignored files. It
rejects tracked dotenv/credential files, unsafe links, oversized files, special
files, and submodules. Safe files become read-only. A SHA-256 digest covers each
final path, file type, executable bit, and byte. The digest is checked again at
the end.

### Snapshot to executable monitoring tree

`src/candidate/check-identity.ts` derives the incident check's stable Checkly
logical ID from the captured config. This also upgrades older bundles that kept
the project logical ID in the manifest. Candidate display names and paths may
change. The logical ID must remain.

Git rename information follows a renamed main spec. The final source imports
follow renamed or new helper files. A missing helper is not restored from the
incident. Removing the stable incident check is a definite `FAILED` result.

`src/patch.ts` loads the complete final Checkly project from the immutable
snapshot. That includes the check, Checkly and Playwright configuration,
package metadata, lockfiles, path-alias helpers, ordinary imports, and binary
test fixtures. Missing files are not restored. The repository digest also
covers files outside the Checkly project. Application behavior is observed
through `--target`.

### Verification logic

The trusted verifier performs static checks first. It compares assertions and
configuration without executing candidate code. The existing assertion ID law,
scene definitions, and decision table are unchanged.

If static checks allow execution, local scene children receive only the listed
runtime variables. They do not inherit Checkly or GitHub credentials. Hybrid
mode gives Checkly credentials only to the approved Checkly CLI child. Candidate
package lifecycle scripts never run in verify-fix.

A target URL and a PR URL are different inputs. The PR URL identifies source.
The target URL identifies a deployment. `--target-metadata` contains the
provider deployment ID, URL, and revision. A protected report is gate-eligible
only when all of these are true:

- the source is an immutable PR head;
- the deployment revision equals that head;
- the deployment URL equals `--target`;
- hybrid cloud verification ran;
- protected approval was declared;
- a fork received explicit approval.

A local target remains useful evidence. It can never satisfy the protected PR
gate.

### Security architecture

The default-branch workflow is the protected gate definition. It checks out the
protected verifier and incident under `trusted/`. It checks out candidate
runtime dependencies under `candidate-runtime/`. The CLI fetches a third,
immutable source snapshot from the PR URL. The candidate cannot replace the
verifier, incident bundle, verdict policy, or workflow that judges it.

The first CI job has no protected secrets. It creates the candidate snapshot and
runs static verification without a target. A statically acceptable candidate is
`UNCERTAIN` at this point because no runtime evidence exists. A definite static
failure blocks immediately. The second job is attached to the protected GitHub
environment. It installs candidate dependencies with `--ignore-scripts`,
installs Chromium in a separate step, creates temporary runtime files, and runs
hybrid verification. PR checks use `CHECKLY_PREVIEW_API_KEY`,
`CHECKLY_PREVIEW_ACCOUNT_ID`, and preview-only test users. Production
credentials are never used for PR checks.

### Output

Markdown and JSON reports now include:

- local or PR source mode;
- repository root and Checkly project path separately;
- base SHA and head SHA;
- dirty state;
- every Git change, including old and new rename paths;
- complete snapshot digest, file count, and byte count;
- PR/fork identity;
- target deployment metadata;
- exact-revision result;
- protected-gate eligibility and its reason;
- the existing scene evidence, Checkly sessions, cost, verdict, and exit code.

The source tree is the runtime truth. The Git diff is only report and policy
data. The tool never trusts an agent-supplied file list or explanation.

---

## 10. Current state

Phases 0–4 are complete. Phase 5 and Phase 6 are implemented and validated
locally. The tool can capture a real Checkly incident, pin a complete local or
GitHub PR candidate revision, load the protected bundle, run DSL or Playwright
checks against a chosen target, split scenes between the local proxy and
Checkly's cloud CLI, grade code/config/app-preview repairs, and return
PASS/FAILED/UNCERTAIN with exit 0/1/2.

The repository has two real captured Playwright incidents. The overlap bundle
has a 20/20 one-at-a-time API baseline and reproduces its 401 in 20/20 browser
pairs. The drift bundle reproduces its stale locator in 20/20 runs. Their
manifests say `method: local-runner`, so the determinism gate is open without
pretending the numbers came from Checkly's cloud.

The automated suite has 123 tests. It uses the real local app for the DSL
suite. It uses fake project-local Playwright and Checkly CLIs for process
boundaries. Candidate-revision tests cover dirty trees, multiple edits, new and
renamed helpers, deletions, credentials, unsafe links, submodules, stable check
identity, exact target binding, fork approval, and complete report identity.
One package test installs the exact npm tarball into a customer project under
the operating-system temp directory, outside this repository. It exercises
local candidate snapshots through both bad and good repairs. The Phase 5
candidates were also run manually through real Chromium against the local app.

The live checkpoint is still open. The user must approve the protected GitHub
environment with the existing Checkly/Vercel values. The corrected drift
monitor must then be deployed. A fresh overlap incident must be captured after
it is green. The three real alternatives plus ten fakes must then run through
Checkly and Vercel. Phase 6 also needs one new real PR run whose report says
`targetBinding.gateEligible: true`. Those actions send real logins and bookings,
so they are not run from this sandbox.

---

## 11. Explaining it in your own words — a cheat sheet

- *What is it?* A deterministic pre-merge gate for AI-proposed repairs of
  monitoring checks.
- *What is the trick?* Run the repaired check in several **known app states**
  (reproduction, healthy, forced failure, regression) and compare what it
  observes with what a real fix **must** observe. A silenced alarm passes the
  forced-failure state — and that convicts it.
- *Why can it be trusted?* No model in the decision path; the verdict is an
  ordered rule table over recorded experiments; every claim traces to a step in
  a sandbox trace; missing evidence is `UNCERTAIN`, never `PASS`.
- *What else does it check?* Static weakening (removed/weakened/guarded
  assertions), environment dodges, flakiness, oracle strength (falsifiability,
  coverage, env completeness, mutation kill rate), and a run budget.
- *How does it run?* Each repetition is a child process. DSL checks use the
  small local check API. Browser checks use the customer's own Playwright.
  Both talk through the scene proxy to the real target or a recording.
