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
| 2b | Second incident on the same app: **drift**. Product renamed `data-testid="book-status"` → `booking-status` (`7db4681`); the check is stale and fails at spec line 36 in every location. Captured with `bundle --out fixtures/bundles/slots-booking-drift` + golden test (`test/bundle/golden-drift.spec.ts`). What the live capture taught: Playwright 1.63 prints `Error: element(s) not found` under `Timeout:` and **no `Received:` line**; the live API nests errors under `playwrightCheckResult` (the first two captures had `failingTest: null`); Checkly filed the drift under the 401 error group, so no automatic RCA ran and the run inherited `INFRASTRUCTURE_ERROR / DO_NOT_REPAIR`. Still open here: no failing request → detection scene `inject:<failing request unknown>` (assertion → network dependency from the passing recording, Phase 3); `failing`/`passing` naming assumes the app broke | fixture with a fresh Rocky RCA (`rca.json#replacedRca` present) committed | first capture committed (`0e1d3ba`, inherited RCA); re-capture with `--trigger-rca` pending |
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
`INFRASTRUCTURE_ERROR / DO_NOT_REPAIR` from two days earlier. The bundle now
records `rca.createdBeforeFailingRun` and `rca.groupErrorMatchesFailingRun`
(the group's first "Received" vs this run's), warns when they disagree, and
`--trigger-rca` then requests a fresh analysis and keeps the old one as
`rca.replaced` / `rca.json#replacedRca`.

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
