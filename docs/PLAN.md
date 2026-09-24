# verify-fix — build plan (agreed 2026-09-21)

Goal: test the tool the way a Checkly customer works. Real app, real Checkly
check, real deploy, real incident — captured by the tool's own command, never
collected by hand. Everything lives in this repo.

```
verify-fix/
├── src/                       the tool
├── packages/create-verify-fix/ Phase 7: standalone live-learning project generator
├── examples/slots-booking/    Example 1: Next.js app + its Checkly Playwright Check Suite, one project (web/)
├── examples/<api-example>/    Example 2 (Phase 6): Express API + ApiCheck
├── fixtures/bundles/          sanitized bundles produced by `verify-fix bundle`
└── .github/workflows/         ci.yml (tests), gate.yml (Phase 5)
```

| Phase | What | Done when | Status |
| --- | --- | --- | --- |
| 0 | Real customer setup: Next.js app + Checkly Playwright Check Suite in ONE project (`web/`: 2 locations, `runParallel`, shared `TEST_USER`, `bundle.packages.prune` so runners skip the app deps), Vercel config | check green on production for a few hours | deployed: Vercel + Upstash + Checkly check `slots booking flow` green |
| 1 | `verify-fix bundle --check <id> [--result <id>] --out ./bundle`: Checkly client, failing + last passing result + assets, trace → HAR, Rocky RCA → `REPRODUCTION` mode, config → `manifest.json`, `--measure N` for determinism | bundle of a green check is produced end to end | built; ran live against the real account (bundle `2d7403c`); hardened against the real Playwright 1.63 trace and result shapes; 34 bundle tests incl. a golden test over the real bundle |
| 2 | Cause the incident (overlapping runs), capture it with `bundle`, commit sanitized output to `fixtures/bundles/slots-booking-overlap/`, golden test | fixture + test committed | **done** — re-captured with the hardened tool (`7351d29`): HAR bodies show the login order (us-east-1 v490 at 19:03:59.221, eu-west-1 v491 at .429, us-east-1 `POST /api/book` 401 `session superseded by a newer login`), `decidedBy: result-timestamps`, `results/history.json` (76/100 passed) |
| 2b | Second incident on the same app: **drift**. Product renamed `data-testid="book-status"` → `booking-status` (`7db4681`); the check is stale and fails at spec line 36 in every location. Captured with `bundle --out fixtures/bundles/slots-booking-drift` + golden test (`test/bundle/golden-drift.spec.ts`). What the live capture taught: Playwright 1.63 prints `Error: element(s) not found` under `Timeout:` and **no `Received:` line**; the live API nests errors under `playwrightCheckResult`; Checkly filed the drift under the 401 error group, so no automatic RCA ran and the run inherited the older RCA. Phase 3 later derived detection `inject:POST /api/book -> 500` from the passing timeline and reproduction `live` from persistent history. | fixture with a fresh Rocky RCA (`rca.json#replacedRca` present) committed — DONE | captured (`5f350e3`, third capture: fresh RCAs `22bb2081`/`95755aa2`, both about `element(s) not found`); manifest upgraded from its retained evidence in Phase 4 |
| 3 | Generic scene layer: `src/scene/proxy.ts` (modes `live` / `live-concurrent:N` / `replay:<har>` / `inject:<METHOD> <path> -> <status>`, one listener per concurrent run, lockstep interleaving), `src/executor/scene.ts` (replaces the synthetic executor; concurrency = min(scene N, what the patched config allows); evidence gate on the proxy's own hit count), Checkly's env convention (`ENVIRONMENT_URL` + `ENVIRONMENT_NAME`, `--target`, `--env-file`, `--env-name`; `APP_BASE_URL` gone; a check that reads an unprovided variable → UNCERTAIN), `--patch <file|dir>` (spec and/or `checkly.config.ts`), config diff + policy (`src/scene/config-diff.ts`: scheduling allowed, retry/timeout-only rejected, new env keys declared), report `environment` column + parity note, v3 bundles load (`src/bundle.ts`), 3.7: drift reproduction `live` from a persistent history and detection `inject:<dependency> -> 500` derived from the passing run's timeline; seeded suite migrated to the real app (`next start`, `test/helpers/example-app.ts`), both `app-sim.ts` deleted, seeded patches 01/02 became config patches (`runParallel: false`), 12 (one location) and 13 (retry-only config) added | suite green with no simulator; overlap 01 + 12 PASS, 02–10 + 13 FAILED, 11 never PASS; drift bundle loads with runnable modes | **done** — 95 tests green at phase completion; Phase 4 now runs the real Playwright specs and closes the deferred drift verdicts |
| 4 | Playwright runner (`src/playwright-sandbox.ts`): copies the captured check tree plus the patch, resolves the customer's `@playwright/test` from `--project`, forces one worker/no retries/JSON report, and runs every browser through the Phase 3 proxy. Browser assets bypass the concurrency barrier; API/fetch calls enter it. `verify-fix measure --bundle --target --project --runs 20` records local determinism with `method: local-runner`. Playwright locator mutations and exact locator-renaming rules are included; candidate fixtures live in `fixtures/patches/`. | overlap: `runParallel:false` + one location PASS, fakes FAILED, flaky never PASS; drift: correct rename PASS, four fakes FAILED; real browser hits the local app | **done** — 103/103 automated tests; both bundles measured locally (overlap sequential 20/20 + reproduction 20/20, drift reproduction 20/20); all candidate fixtures plus a replay scene graded through Chromium against `next start` |
| 5 | Live loop + CI gate: hybrid executor sends HEALTHY/REGRESSION to the customer project's `checkly test --record --reporter json --retries 0`; REPRODUCTION/DETECTION stay in the local scene proxy. `--candidate-project` reads PR monitoring files. `gate.yml` binds verification to the exact Vercel deployment SHA/URL. PRs only test. Production runs `checkly deploy --force` after PASS. Every report records cloud/local/mutation runs, browser processes, and wall time. | gate blocks a bad fix on a real PR; three real alternatives PASS; ten fakes FAIL on the real account | **local implementation done** — drift locator repaired in source; 115/115 tests; the npm tarball installs and runs from an external customer project against a customer-selected target; real Chromium: drift repair PASS, `runParallel:false` config repair PASS, per-region users PASS, session-lease app PASS, ten fakes FAILED, flaky UNCERTAIN. Live Checkly/Vercel gate proof and fresh post-drift overlap capture still require the customer's account. |
| 6 | Example 2: Express API + ApiCheck with `{{ENVIRONMENT_URL}}`, changed-response incident, replay mode, host-only replacement, retry-config fakes | second bundle + golden test | not started |
| 7 | CLI initialization plus a copied live learning project: `verify-fix init` prepares the CLI inside an existing Checkly project. The separate create command copies the maintained slots-booking example into a standalone directory. The copied README teaches the complete learner-owned setup and workflow. | packed `verify-fix init` configures an external customer project; the packed creator copies the real example outside this repo; a learner completes GitHub → Vercel → Upstash → Checkly → incident → bundle → repair → PR gate with no mock inside the copied project | blocked on Phase 6 |

## Phase 7 — CLI setup and copied live learning project

Phase 7 starts only after Phase 6 is complete.

| Task | Technical detail |
| --- | --- |
| 7.1 CLI init command | `verify-fix init` prepares verify-fix inside the current existing Checkly project. It detects the project files. It writes only the agreed CLI configuration and package scripts after confirmation. It does not create or copy the example project. It never provisions services. It never reads or stores credentials. |
| 7.2 Copy the maintained example | `npm create verify-fix@latest <dir> -- --template slots-booking-live` invokes `create-verify-fix`. The command copies the maintained template from `examples/slots-booking/web` plus its example workflow into a standalone directory. It does not synthesize a second app or check implementation. It may replace only documented project placeholders. It refuses a non-empty destination. The copied project starts with an empty `incidents/` directory. |
| 7.3 Example README owns the learning steps | Maintain the full workshop instructions in the example project's README. The copied README explains how to create the GitHub repository, deploy to Vercel, attach Upstash, authenticate Checkly, deploy the scheduled check, configure protected GitHub environments, use every verify-fix command, recover from setup failures, understand possible Checkly usage and alerts, and remove every external resource. Credentials stay in the learner's environment. Rocky Automatic Repair remains off. |
| 7.4 Fresh incident and full loop | The two real Checkly locations use the same test account against the shared Upstash store. Their collision creates the learner's real incident. The learner runs `verify-fix bundle` to create the first contents of `incidents/`, creates a repair branch, verifies against the exact preview URL and revision, opens a pull request, and lets the CI gate decide before `checkly deploy`. No captured incident is copied into the learning project. |
| 7.5 Package and safety proof | Pack `verify-fix` and `create-verify-fix`. Run `verify-fix init` against a temporary existing customer project outside this repo. Run the packed creator in another temporary directory. Confirm the copied project has no repository-relative imports. Install and run its real Next.js app, Chromium, Playwright, Checkly CLI, and verify-fix. Confirm that no mock, secret, pre-captured incident, build cache, report, or raw trace enters the copied project. Complete the account-backed workshop from the user's machine. |

**Done when:** the packed `verify-fix init` command configures an existing external
Checkly project without creating an example. The packed creator copies the
maintained example into a separate standalone project. Its README guides the
full learner-owned flow on real accounts. The copied project starts with no
incident. `verify-fix bundle` captures its fresh incident. A real repair passes.
A bad repair fails. The pull-request gate binds the verdict to the exact preview
revision. No mock, secret, generated duplicate implementation, or
repository-relative dependency exists inside the copied project.

How the `REPRODUCTION` mode is decided (learned from the real bundle, where
Rocky classified the overlap incident as `INFRASTRUCTURE_ERROR / DO_NOT_REPAIR`):

1. **Result timestamps first.** If another run of the same check, from another
   location, has a `[startedAt, stoppedAt]` window that intersects the failing
   run's **and that run passed**, the mode is `live-concurrent:2`
   (`matchedRule: overlapping-run`, `decidedBy: result-timestamps`). One copy
   won and one lost: that is the signature of a concurrency/state incident.
   With `runParallel` every run has a sibling; a sibling that failed too is
   recorded in `overlappingRuns` and in a note but decides nothing (that is
   the shape of drift or an app-wide outage). This is arithmetic on Checkly's
   own data, not a reading of any text. The bundle keeps the result window in
   `results/history.json` so the overlap can be re-checked offline.
2. **Persistent history second** (Phase 3.7). If every final run after the
   last passing one failed, in every location, at least 3 runs, and no request
   failed in the failing run, the failure does not depend on timing: the
   target as it is now reproduces it → `live` (`matchedRule:
   persistent-failure`, `decidedBy: history`). That is drift. The detection
   scene is then derived from the **passing** run's timeline: the last API call
   before the step that failed (Playwright's monotonic clock on both the
   actions and the HAR) is the step's dependency; the scene answers that call
   with a 500 on top of a live run, and a repaired check must still fail
   (`failurePoint.dependency`, provenance `recordings/passing.har`).
3. **Rule table third.** Otherwise the RCA text (or the error-group message)
   goes through the fixed table in `src/bundle/rca-mode.ts`.
4. **Nothing matched → `both`** (`live-concurrent:2` first, `replay:failing.har`
   as the alternative; the scene is UNCERTAIN if neither reproduces).

When the RCA text and the timestamps disagree, the manifest says so in
`notes` and follows the timestamps. Rocky's classification and
`repairRecommendation` are recorded, never followed blindly.

Is the RCA even about this failure? Seen live on 2026-09-23: after the UI
rename, the `element(s) not found` failures were attributed to the existing
401 error group (Checkly's grouping drops the Expected/Received values), so no
new error group appeared, no automatic RCA ran, and the drift inherited
`INFRASTRUCTURE_ERROR / DO_NOT_REPAIR` from two days earlier. The bundle
records three signals — `rca.createdBeforeFailingRun`,
`rca.groupErrorMatchesFailingRun` (the group's first outcome vs this run's)
and `rca.mentionsFailingRunReceived` (does Rocky's text contain this run's
outcome) — and derives `rca.describesFailingRun`: `false` when an RCA older
than the run sits on a group that merges different failures, or never mentions
the run's outcome (stale); `true` with positive evidence; `null` when nobody
can tell from the outside. An RCA created after the run is never stale: the
group message never updates, so a mismatch there says nothing about a later
analysis, and re-requesting it on every capture would loop. `--trigger-rca`
requests a fresh analysis only for stale or missing RCAs (`POST
/v1/root-cause-analyses/error-groups/{id}`, 202 + `{id, status: PENDING}`,
polled like `checkly rca run --watch`) and keeps the old one as
`rca.replaced` / `rca.json#replacedRca`.

Answered live on 2026-09-23 (third capture, `5f350e3`): the on-demand RCA
analyzes the group's **latest** failure — both fresh analyses talk about
`getByTestId('book-status')` / `element(s) not found`, the 401 is gone. Rocky
could not open the trace ("recorded with a newer Playwright version than the
available viewer", Playwright 1.63), so it could not tell locator drift from an
app failure: `UNKNOWN_ERROR`, `repairRecommendation: REVIEW`, `codeFix: null`.
For the drift example the candidate fixes therefore come from us, not from
Rocky. The same capture exposed a rule bug: a recurring failure makes every new
failing run younger than any RCA, so "created before this run" alone must never
mark an RCA stale — a text that names the run's outcome settles it
(`rcaFit`, `mentions === true` → describes). The capture requested one RCA too
many because of that; the fixture keeps both.

Rules that do not change between phases (see BRAINSTORM.md Part 7, D1–D9):
no LLM in the decision path; the decision table is law; credentials only via
the customer's environment; the tool never provisions environments and never
runs `checkly deploy` or `checkly env add` itself.

Phase 0 fixes to judge later (all for the same incident):

- **config fix** — one location, or `runParallel: false`;
- **code fix** — one stable declared test user per Checkly location, selected
  through `CHECKLY_REGION`; runtime-generated accounts remain forbidden;
- **app fix** — an Upstash-backed session lease per login; booking atomically
  consumes its own lease, so a later login does not invalidate it.

And the fakes: retry/timeout-only changes, deleted assertions, `try/catch`,
soft expects, sleeping, asserting on the login page only.
