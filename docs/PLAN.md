# verify-fix — build plan (agreed 2026-09-21)

Goal: test the tool the way a Checkly customer works. Real app, real Checkly
check, real deploy, real incident — captured by the tool's own command, never
collected by hand. Everything lives in this repo.

```
verify-fix/
├── src/                       the tool
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
| 2b | Second incident on the same app: **drift**. Product renamed `data-testid="book-status"` → `booking-status` (`7db4681`); the check is stale and fails at spec line 36 in every location. Captured with `bundle --out fixtures/bundles/slots-booking-drift` + golden test (`test/bundle/golden-drift.spec.ts`). What the live capture taught: Playwright 1.63 prints `Error: element(s) not found` under `Timeout:` and **no `Received:` line**; the live API nests errors under `playwrightCheckResult` (the first two captures had `failingTest: null`); Checkly filed the drift under the 401 error group, so no automatic RCA ran and the run inherited `INFRASTRUCTURE_ERROR / DO_NOT_REPAIR`. Still open here: no failing request → detection scene `inject:<failing request unknown>` (assertion → network dependency from the passing recording, Phase 3); `failing`/`passing` naming assumes the app broke | fixture with a fresh Rocky RCA (`rca.json#replacedRca` present) committed — DONE | captured (`5f350e3`, third capture: fresh RCAs `22bb2081`/`95755aa2`, both about `element(s) not found`) |
| 3 | Generic scene layer: proxy modes passthrough / replay / inject / concurrent, `ENVIRONMENT_URL` + `ENVIRONMENT_NAME`, `--target`, `--env-file`, evidence gate, `environment` column, config diff + credential policy; migrate the 11 seeded patches; delete `app-sim.ts` | 25+ tests green on the new layer, seeded verdicts unchanged | |
| 4 | Playwright runner: `page.route` inject, `routeFromHAR` replay, two contexts for concurrent, `page.on('request')` evidence | real spec runs through all four scene modes | |
| 5 | Live loop + CI gate (`gate.yml`: preview → `verify-fix verify --target staging --env-file .env.staging` → exit 0 → `checkly deploy`); three real fixes PASS, ten fakes FAIL; cost report | gate blocks a bad fix on a real PR | |
| 6 | Example 2: Express API + ApiCheck with `{{ENVIRONMENT_URL}}`, changed-response incident, replay mode, host-only replacement, retry-config fakes | second bundle + golden test | |

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
2. **Rule table second.** Otherwise the RCA text (or the error-group message)
   goes through the fixed table in `src/bundle/rca-mode.ts`.
3. **Nothing matched → `both`** (`live-concurrent:2` first, `replay:failing.har`
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
- **code fix** — a distinct test user per run (for example one account per
  location, or a per-run suffix), configured through env-var names only; the
  exact mechanism is decided when the fix is written in Phase 5;
- **app fix** — allow several sessions per account (removes the rule itself).

And the fakes: retry/timeout-only changes, deleted assertions, `try/catch`,
soft expects, sleeping, asserting on the login page only.
