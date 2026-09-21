# verify-fix — build plan (agreed 2026-09-21)

Goal: test the tool the way a Checkly customer works. Real app, real Checkly
check, real deploy, real incident — captured by the tool's own command, never
collected by hand. Everything lives in this repo.

```
verify-fix/
├── src/                       the tool
├── examples/slots-booking/    Example 1: Next.js app (web/) + Checkly project (monitoring/)
├── examples/<api-example>/    Example 2 (Phase 6): Express API + ApiCheck
├── fixtures/bundles/          sanitized bundles produced by `verify-fix bundle`
└── .github/workflows/         ci.yml (tests), gate.yml (Phase 5)
```

| Phase | What | Done when | Status |
| --- | --- | --- | --- |
| 0 | Real customer setup: Next.js app, Checkly Playwright Check Suite (2 locations, `runParallel`, shared `TEST_USER`), Vercel config | check green on production for a few hours | deployed: Vercel + Upstash + Checkly check `slots booking flow` green |
| 1 | `verify-fix bundle --check <id> [--result <id>] --out ./bundle`: Checkly client, failing + last passing result + assets, trace → HAR, Rocky RCA → `REPRODUCTION` mode, config → `manifest.json`, `--measure N` for determinism | bundle of a green check is produced end to end | built + 25 new tests (fake Checkly over HTTP); first live run against the real account pending |
| 2 | Cause the incident (overlapping runs), capture it with `bundle`, commit sanitized output to `fixtures/bundles/slots-booking-overlap/`, golden test | fixture + test committed | |
| 3 | Generic scene layer: proxy modes passthrough / replay / inject / concurrent, `ENVIRONMENT_URL` + `ENVIRONMENT_NAME`, `--target`, `--env-file`, evidence gate, `environment` column, config diff + credential policy; migrate the 11 seeded patches; delete `app-sim.ts` | 25+ tests green on the new layer, seeded verdicts unchanged | |
| 4 | Playwright runner: `page.route` inject, `routeFromHAR` replay, two contexts for concurrent, `page.on('request')` evidence | real spec runs through all four scene modes | |
| 5 | Live loop + CI gate (`gate.yml`: preview → `verify-fix verify --target staging --env-file .env.staging` → exit 0 → `checkly deploy`); three real fixes PASS, ten fakes FAIL; cost report | gate blocks a bad fix on a real PR | |
| 6 | Example 2: Express API + ApiCheck with `{{ENVIRONMENT_URL}}`, changed-response incident, replay mode, host-only replacement, retry-config fakes | second bundle + golden test | |

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
