# verify-fix — build plan (updated 2026-09-24)

Goal: test the tool the way a Checkly customer works. Real app, real Checkly
check, real deploy, real incident — captured by the tool's own command, never
collected by hand. Everything lives in this repo.

```
verify-fix/
├── src/                       the tool
├── packages/create-verify-fix/ Phase 8: standalone live-learning project generator
├── examples/slots-booking/    Next.js app + Playwright suite + ApiCheck, one project (web/)
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
| 5 | Live loop + CI gate: hybrid executor sends HEALTHY/REGRESSION to the customer project's `checkly test --record --reporter json --retries 0`; REPRODUCTION/DETECTION stay in the local scene proxy. `--candidate-project` reads PR monitoring files. `gate.yml` binds verification to the exact Vercel deployment SHA/URL. PRs only test. Production runs `checkly deploy --force` after PASS. Every report records cloud/local/mutation runs, browser processes, and wall time. | gate blocks a bad fix on a real PR; three real alternatives PASS; ten fakes FAIL on the real account | **done** — local matrix passed; the protected exact-revision Checkly/Vercel gate passed at commit `01f71b8` in run `36041826149`. |
| 5.5 | Candidate revision intake: replace the production idea of one agent patch with the complete final project state. Support both a local working tree and a pull request URL. Treat every agent change as untrusted. Bind PR verification to the exact preview revision. | the same multi-file candidate is verified from a fixed local snapshot and from an exact PR head; reports record source identity and all file changes; the candidate cannot replace the verifier, incident, policy, or gate | **done** — immutable dirty-tree and exact GitHub PR snapshots, stable logical-ID matching, rename/deletion/import handling, complete source reports, target metadata binding, fork/approval controls, protected two-stage workflow, package proof, 123/123 local tests, and the successful protected proof at exact commit `01f71b8`. |
| 6 | Authenticated booking API + Checkly `ApiCheck` in the existing Next.js and Checkly project: `{{ENVIRONMENT_URL}}` with no fallback, real setup, exact contract, real field-rename incident, sanitized API evidence, deterministic API scenes, and complete-candidate verification | real Vercel deployment and Checkly API check produce a fresh `availability` → `status` incident; strict direct and imported-helper repairs PASS; weakening, redirect, response rewriting, retry, and timeout candidates FAIL; missing input is UNCERTAIN | **real incident captured; final gate pending** — the baseline passed, the app-only rename failed on the exact field assertion, the CLI bundle captured 2 passing and 2 failing scheduled results plus 20/20 recurring failures and Rocky RCA, and the strict repair passed HEALTHY/REPRODUCTION/DETECTION with 15 completed requests/replays; the exact-revision protected account gate is next |
| 7 | Multistep Check support starts only after API support is complete | a meaningful booking workflow incident is captured and verified with the same protected boundaries | blocked on Phase 6 |
| 8 | CLI initialization plus a copied live learning project: `verify-fix init` prepares the CLI inside an existing Checkly project. The separate create command copies the maintained slots-booking example into a standalone directory. The copied README teaches the complete learner-owned setup and workflow. | packed `verify-fix init` configures an external customer project; the packed creator copies the real example outside this repo; a learner completes GitHub → Vercel → Upstash → Checkly → incident → bundle → repair → PR gate with no mock inside the copied project | blocked on Phase 7 |

## Phase 5.5 — Complete candidate revisions from local work or a pull request

The complete-candidate implementation and its account-backed protected-gate proof are complete. The successful exact-revision proof is preserved at commit `01f71b8`.

| Task | Technical detail |
| --- | --- |
| 5.5.1 Candidate revision model | Replace the production idea of a single patch with a candidate revision. A candidate revision is the complete final project state. Multiple files, multiple edits within one file, new helpers, renames, deletions, configuration changes, dependency changes, monitoring changes, and application changes are normal inputs. Execute the final tree. Use the Git diff only for reporting and policy checks. Keep `--patch <file\|dir>` only for fixtures, backwards compatibility, and small manual experiments. |
| 5.5.2 Local working-tree input | `verify-fix verify --candidate-project <dir> --base <git-ref> ...` creates an immutable temporary snapshot before verification. Build it from tracked files plus non-ignored untracked files. Preserve staged and unstaged content. Record the base SHA, current HEAD, dirty state, changed paths, rename and deletion status, and a content digest. Exclude `.git`, dependencies, build output, credentials, dotenv files, and unsafe links. A user-supplied local target is valid for pre-PR learning, but its source binding is marked local and cannot satisfy the authoritative merge gate. |
| 5.5.3 Pull-request URL input | `verify-fix verify --pr <url> --bundle <dir> --target <url> ...` initially supports GitHub pull request URLs. Resolve the repository, pull-request number, base SHA, and exact head SHA through authenticated GitHub access from the user's environment. Fetch the immutable head into a temporary checkout. Never follow a moving branch after the run starts. Keep the target URL separate from the PR URL. Require deployment metadata to prove that `--target-revision` equals the PR head before authoritative cloud verification. Support private same-repository pull requests. Fork pull requests receive no protected credentials and cannot run the protected cloud stage without explicit approval. |
| 5.5.4 File and check identity | Discover changes with Git instead of trusting the agent's description. Match the incident check by stable Checkly logical identity instead of only its file path or display name. Include changed monitoring files and their actual relative imports. Treat removal of the incident check as a definite failure. Resolve renamed helpers from the final tree. Observe application-file changes through the supplied deployment. Allow app-only, monitoring-only, configuration-only, and combined repairs. |
| 5.5.5 Untrusted-candidate boundary | Install and execute a pinned trusted `verify-fix` package outside the candidate checkout. Load the incident bundle, verdict policy, and gate workflow from protected base-controlled inputs. Do not allow the candidate to modify the code that judges it. Run secret-free static checks first. Do not run candidate lifecycle scripts in the trusted job. Require protected-environment approval before candidate Checkly configuration or check code receives preview-only values and Checkly credentials. A candidate that lacks approval stops before the cloud stage. Production credentials never enter pull-request verification. |
| 5.5.6 Checkly-native CI flow | Follow Checkly's normal order: keep checks beside application code, deploy the candidate application, test the checked-out candidate checks against `ENVIRONMENT_URL`, merge only after PASS, deploy the application to production, verify the production revision, then run `checkly deploy`. The core accepts any target provider. The Vercel workflow remains one provider adapter. Reports record repository URL, input mode, base SHA, head SHA or local digest, changed files, target URL, target revision, and source-binding strength. |
| 5.5.7 Proof matrix | Add external-repository tests for multi-file and multi-hunk changes, new and renamed helpers, deletions, app-only repairs, check-only repairs, combined app/check repairs, configuration and lockfile changes, staged and unstaged edits, untracked files, unsafe links, moving PR heads, target-revision mismatches, fork PRs, and attempts to replace the bundle, verifier, policy, or workflow. The same candidate must produce the same verdict in local and PR modes when both execute the same source and target. Finish with a real GitHub pull request, real preview, real Checkly session, and real protected gate from the user's machine. |

### Important Phase 5.5 cases

- **Many files and many edit locations.** Read the complete final files. Do not require one diff, one hunk, one file, or an agent-specific response format.
- **New helper files.** Include new non-ignored files that the candidate monitoring code imports.
- **Renamed helper files.** Resolve imports from the final tree. Do not fall back to an old path from the incident bundle.
- **Deleted helper files.** Preserve the deletion. Do not silently restore the captured copy.
- **Deleted incident check.** Return FAILED when the candidate removes the monitor that reported the incident.
- **Renamed incident check.** Follow the stable Checkly logical ID. Do not depend only on a file path or display name.
- **Application-only repair.** Keep the captured monitoring code. Judge the application change through the candidate target URL.
- **Monitoring-only repair.** Execute the candidate monitoring tree against the supplied target.
- **Combined repair.** Require the candidate monitoring source and candidate application deployment to belong to the same revision.
- **Configuration and dependency changes.** Include Checkly configuration, Playwright configuration, package manifests, lockfiles, and imported source in the candidate identity.
- **Local dirty tree.** Include staged edits, unstaged edits, and non-ignored untracked files in one immutable snapshot.
- **Local target limitation.** Mark a user-supplied local target as local evidence. Do not let it satisfy the protected merge gate.
- **Moving pull request.** Pin the head SHA at the start. Reject target metadata for another SHA. Require a new run when the PR head changes.
- **PR URL and target URL.** Treat them as separate inputs. A PR URL identifies source. Deployment metadata must prove which revision produced the target URL.
- **Private repository.** Read GitHub authentication from the user's environment. Never write it into project files or reports.
- **Fork pull request.** Run no protected cloud stage until an authorized reviewer approves access. Never expose production credentials.
- **Untrusted agent output.** Ignore the agent's description and claimed file list. Inspect Git and the final source tree directly.
- **Candidate changes to verify-fix.** Execute a pinned trusted package outside the candidate checkout.
- **Candidate changes to evidence or policy.** Load the incident bundle and verdict policy from a protected base-controlled location.
- **Candidate changes to CI.** The deployment adapter calls the reusable gate at an immutable reviewed commit. Require the called gate's check names in the repository ruleset and owner review for workflow changes. Do not let the candidate replace or bypass the workflow that judges it.
- **Executable Checkly configuration.** Treat `checkly.config.*` as untrusted code. Run secret-free checks first. Require approval before cloud credentials enter its process.
- **Candidate package scripts.** Do not run lifecycle scripts in the trusted verification job. Install the browser through a separate trusted step.
- **Unsafe project entries.** Reject credential files, unsafe symbolic links, submodules that leave the project, build output, dependencies, and files outside the snapshot root.
- **Monorepo project path.** Record the repository root and Checkly project directory separately. Resolve all candidate paths inside those roots.
- **Run stability.** Keep the snapshot unchanged until every scene and mutation run finishes. Report one digest for the complete run.

**Done when:** local mode snapshots and verifies a complete dirty working tree without
requiring a pull request. Pull-request mode resolves and verifies an immutable
head revision. Both modes support changes across any number of files and any
number of locations inside those files. The PR gate proves that the preview
revision equals the candidate head. An untrusted agent cannot replace the
verifier, incident, verdict policy, or gate. No protected credential reaches a
candidate before approval. A real repair passes. A bad repair fails. Existing
assertion identity, oracle scenes, and decision law remain unchanged.

## Phase 6 — Authenticated booking API and Checkly ApiCheck

Phase 6 uses only `examples/slots-booking/web/`. It adds a meaningful API
monitor to the existing Next.js application and existing Checkly project. It
does not create an Express service, a Railway deployment, or a second Checkly
project.

| Task | Technical detail |
| --- | --- |
| 6.1 Booking API | Add `GET /api/v1/availability?slot=09:30`. Require a bearer token from `API_TOKEN`. Return the baseline contract `{ "slot": "09:30", "availability": "AVAILABLE" }`. Keep the existing browser booking flow unchanged. |
| 6.2 Checkly ApiCheck | Add one stable `ApiCheck` to the current Checkly project. Use `{{ENVIRONMENT_URL}}` with no fallback. A setup entrypoint reads `API_TOKEN`, adds `Authorization`, and adds `x-request-id`. Assert exact status, content type, slot, and availability. |
| 6.3 Real incident | Deploy the baseline app and check through the user's existing Vercel and Checkly accounts. Keep the check green first. Then rename the response field from `availability` to `status` without changing the check. Capture the fresh failing result and passing history with `verify-fix bundle`. Do not assume the RCA classification. |
| 6.4 API evidence | Store a sanitized API request and response, result history, setup source hash, asset hashes, and RCA. Preserve valid JSON. Remove authorization, cookies, tokens, account data, and configured secret values. Unreadable, truncated, malformed JSON, and unsupported binary evidence produce UNCERTAIN. |
| 6.5 Static API model | Parse `ApiCheck` and `AssertionBuilder` with the TypeScript AST. Resolve static imported arrays, constants, and helpers. Keep `src/assertion/id.ts` unchanged. An expression that cannot be resolved safely produces UNCERTAIN. |
| 6.6 Deterministic scenes | HEALTHY sends the candidate check to the exact Vercel target through the current Checkly CLI path. REPRODUCTION replays the sanitized changed response. DETECTION replays the last passing response, which contains the old field. Run setup before every request. Setup failure means no request and no assertion execution. |
| 6.7 Candidate policy | Preserve origin templating, route, query, method, body, setup boundary, status assertion, content-type assertion, and exact JSON contract strength. Reject assertion removal, weaker operators, `/health` redirection, hardcoded hosts, `shouldFail`, response rewriting, setup or teardown suppression, retry changes, and timeout-only repairs. |
| 6.8 Complete revisions and gate | Reuse complete local and pull-request candidate intake. Support check, setup helper, config, dependency, application, and combined changes. Reuse the Vercel exact-revision gate. Replay proves monitoring repairs. It does not by itself prove an application-only repair that changes the response. |
| 6.9 Proof | Add unit, integration, rejection-matrix, bundle, and packed-CLI tests. Run the real app with real HTTP traffic locally. Then use the user's Mac for the real Checkly and Vercel capture and exact-revision proof. Credentials stay in the user's environment. Rocky Automatic Repair stays off. |

### Important Phase 6 cases

- `{{ENVIRONMENT_URL}}` has no fallback. Missing target input is UNCERTAIN.
- Only the origin may be replaced. Route, query, method, body, and relevant headers stay fixed.
- Setup failure stops execution before the request.
- Setup and teardown code may not rewrite a response or hide an assertion.
- Retries can measure recurrence. They cannot repair a broken contract.
- Only operators confirmed by real Checkly parity sessions are executable.
- The CLI creates every bundle. No API result, request, response, RCA, trace, or verdict is fabricated.
- Vercel supplies a URL and exact revision. No Vercel API belongs in the core decision engine.

### Real Phase 6 evidence checkpoint

The real account baseline passed before the application-only field rename. The
captured bundle is `incidents/slots-availability-api`. It contains two passing
and two failing scheduled results, sanitized passing and failing API bodies,
setup SHA-256 provenance, 20/20 recurring measured failures, and the available
Rocky RCA. The bundle stores only an account hash and redacts the request origin
and authorization value.

Rocky classified the incident as `CONFIGURATION_ERROR / DO_NOT_REPAIR`. Its
analysis says the API still returned `availability`, but the captured failing
response actually contains `status`. The classification is retained as real
evidence, not accepted as runtime truth. The deterministic verifier uses the
recorded responses and exact assertions instead. The strict field repair passed
HEALTHY, REPRODUCTION, and DETECTION with 15 completed API requests/replays and
oracle strength 1.000.

The live capture also exposed parity details that fixtures had missed. Checkly
records the sanitized origin as `[REDACTED]`, an empty GET body as `""`, and the
slot query with percent encoding. The executor now recognizes that safe origin
marker, normalizes only the empty-body representation and query encoding, and
continues to compare the route, query, method, body, and setup identity.

**Done when:** the baseline API is green on the real Vercel deployment. The
real field rename creates a fresh Checkly failure. The CLI captures sanitized
request, response, history, setup provenance, and RCA evidence. Strict direct
and imported-helper monitoring repairs PASS. Weakening and masking candidates
FAIL. Missing or unsupported evidence is UNCERTAIN. The exact-revision Vercel
gate passes for the real repair.

## Phase 7 — Meaningful Multistep Check support

Phase 7 starts only after Phase 6 API support and its real account proof are
complete. It will use the same booking application and Checkly project. The
scope must be a meaningful booking workflow. It must not add check types only
to create a catalogue. Its detailed plan will be written from real Checkly
Multistep result evidence before implementation.

## Phase 8 — CLI setup and copied live learning project

Phase 8 starts only after Phase 7 is complete.

| Task | Technical detail |
| --- | --- |
| 8.1 CLI init command | `verify-fix init` prepares verify-fix inside the current existing Checkly project. It detects the project files. It writes only the agreed CLI configuration and package scripts after confirmation. It does not create or copy the example project. It never provisions services. It never reads or stores credentials. |
| 8.2 Copy the maintained example | `npm create verify-fix@latest <dir> -- --template slots-booking-live` invokes `create-verify-fix`. The command copies the maintained template from `examples/slots-booking/web` plus its example workflow into a standalone directory. It does not synthesize a second app or check implementation. It may replace only documented project placeholders. It refuses a non-empty destination. The copied project starts with an empty `incidents/` directory. |
| 8.3 Example README owns the learning steps | Maintain the full workshop instructions in the example project's README. The copied README explains how to create the GitHub repository, deploy to Vercel, attach Upstash, authenticate Checkly, deploy the scheduled check, configure protected GitHub environments, use every verify-fix command, recover from setup failures, understand possible Checkly usage and alerts, and remove every external resource. Credentials stay in the learner's environment. Rocky Automatic Repair remains off. |
| 8.4 Fresh incident and full loop | The two real Checkly locations use the same test account against the shared Upstash store. Their collision creates the learner's real incident. The learner runs `verify-fix bundle` to create the first contents of `incidents/`, creates a repair branch, verifies against the exact preview URL and revision, opens a pull request, and lets the CI gate decide before `checkly deploy`. No captured incident is copied into the learning project. |
| 8.5 Package and safety proof | Pack `verify-fix` and `create-verify-fix`. Run `verify-fix init` against a temporary existing customer project outside this repo. Run the packed creator in another temporary directory. Confirm the copied project has no repository-relative imports. Install and run its real Next.js app, Chromium, Playwright, Checkly CLI, and verify-fix. Confirm that no mock, secret, pre-captured incident, build cache, report, or raw trace enters the copied project. Complete the account-backed workshop from the user's machine. |

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
