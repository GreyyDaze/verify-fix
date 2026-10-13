# Verify-Fix: Testing and Evidence

## Purpose

This document separates three things that must not be confused:

1. tests of the code
2. tests of the CLI and application together
3. acceptance against the real Checkly provider

## 1. Test categories

| Category | What it proves | Provider real? | CLI real? | Application real? |
|---|---|---:|---:|---:|
| Unit / contract | One implementation rule | No | Usually no | No |
| CLI integration | Production CLI wiring | Usually no | Yes | Often yes |
| Application integration | Real verification behavior | No | Yes in key tests | Yes |
| Workflow tests | CI gate structure and shell behavior | No | No or partial | No |
| External package test | Installed package works outside repo | No | Yes | Synthetic/local |
| Real-provider acceptance | Checkly integration | Yes | Yes | Depends on target |

## 2. Current contract-test examples

Remote asset tests cover:
- authenticated Checkly-origin downloads
- unauthenticated presigned downloads
- HTTPS-only rules
- redirects
- byte limits
- result history requests
- Multistep manifest selection
- archive entry selection
- invalid manifest shapes
- invalid sources
- invalid content types
- duplicate evidence names
- bounded ZIP parsing

These test failure boundaries deterministically. They do not prove that the live Checkly API currently returns those exact shapes.

## 3. Current CLI integration examples

Important tests include:

- test/verify.spec.ts
- test/bundle/cli-http.spec.ts
- test/package/external-customer.spec.ts
- test/checkly-sandbox.spec.ts
- test/playwright-sandbox.spec.ts

These exercise production CLI code. Some deliberately replace external services with local stand-ins. That is useful for deterministic testing but is not live-provider evidence.

## 4. Real application evidence

The seeded slots-booking application is used to reproduce real application behavior.

The verification tests check:
- the original failure is actually observed
- the verifier contacts the application
- a good repair passes
- known bad repairs fail
- weakened assertions are detected
- configuration-only or retry-only changes do not create a false PASS
- repeated observations remain deterministic where required

## 5. Real Checkly acceptance

The live provider path is separate from npm test:

```
authenticated Checkly credentials
        ↓
real Checkly check
        ↓
real FINAL result history
        ↓
real failing + passing results
        ↓
real result assets
        ↓
verify-fix bundle
        ↓
existing verifier
        ↓
CLI decision + exit code
```

The repository now has two acceptance levels:

1. bundle acceptance: proves real Checkly discovery, result selection, evidence acquisition, parsing, normalization, and leak protection
2. verification acceptance: proves the real captured bundle reaches the actual CLI verifier and produces PASS, FAILED, and UNCERTAIN correctly

## 6. What the normal test suite should not claim

Mocked-provider tests must not be described as proof that:
- Checkly returned the expected live manifest
- Checkly accepted the request
- the live Checkly asset endpoint works
- the provider's current response shape is proven

Correct wording:
- the provider contract is tested with a synthetic manifest
- the HTTP client behavior is tested with a controlled response
- the CLI path is tested with a local provider stand-in
- live Checkly acceptance was verified separately

## 7. Acceptance gaps

### Gap 1: Live credentials must stay out of npm test

The normal suite remains credential-free. Live acceptance uses an explicit command and controlled credentials.

### Gap 2: Bundle acceptance is not verification acceptance

A real bundle proves provider acquisition. It does not by itself prove that the verifier can grade a candidate against the captured incident.

The dedicated verification acceptance closes that gap.

### Gap 3: Live target and candidate credentials are external inputs

The full verification acceptance intentionally requires a real target origin and a private env file. These values are never written into the bundle or reports.

## 8. Acceptance standard

A feature is fully accepted only when both are true:

1. deterministic tests prove implementation invariants
2. real-provider acceptance proves the external integration and the end-to-end verification decision

Neither replaces the other.

## 9. Evidence hierarchy

From lowest to highest external realism:

1. pure unit test
2. synthetic provider contract test
3. CLI integration against local stand-in
4. CLI against a real local/deployed application
5. authenticated real-provider bundle acceptance
6. authenticated real-provider verification acceptance
7. complete protected production verification

A lower level cannot automatically prove the levels above it.

## 10. Dedicated live Checkly commands

### Bundle acceptance

```bash
VERIFY_FIX_ACCEPTANCE_CHECK_ID=<real-check-id> npm run test:checkly
```

Optional:

```bash
VERIFY_FIX_ACCEPTANCE_PROJECT=<checkly-project-dir>
VERIFY_FIX_ACCEPTANCE_RESULT_ID=<specific-failing-result-id>
VERIFY_FIX_ACCEPTANCE_PASS_RESULT_ID=<specific-passing-result-id>
VERIFY_FIX_ACCEPTANCE_OUT=<output-dir>
```

This command fetches the real check, real FINAL history, selected failing/passing results, real evidence, and writes the production bundle.

### Full verification acceptance

```bash
VERIFY_FIX_ACCEPTANCE_CHECK_ID=<real-check-id> \
VERIFY_FIX_ACCEPTANCE_RESULT_ID=<failing-result-id> \
VERIFY_FIX_ACCEPTANCE_PASS_RESULT_ID=<passing-result-id> \
VERIFY_FIX_ACCEPTANCE_TARGET=https://<real-target-origin> \
VERIFY_FIX_ACCEPTANCE_ENV_FILE=/private/path/checkly.env \
VERIFY_FIX_ACCEPTANCE_PATCH=/path/to/known-good-patch \
VERIFY_FIX_ACCEPTANCE_PROJECT=/path/to/project \
npm run test:checkly:verify
```

Optional:

```bash
VERIFY_FIX_ACCEPTANCE_OUT=<output-dir>
```

The full command:
1. captures the real Checkly incident through the production bundle path
2. runs the actual CLI verifier with the known valid repair
3. requires `PASS` / exit 0
4. runs the captured original check as a no-op candidate
5. requires `FAILED` / exit 1
6. runs the valid repair without `--target`
7. requires `UNCERTAIN` / exit 2
8. writes JSON and Markdown reports for the PASS and FAILED cases

The command is intentionally outside `npm test`. It requires real Checkly credentials, a controlled real target, a private env file, and explicit local paths for the candidate patch and dependency project. The example slots-booking project is only a demonstration/test fixture; it is not part of the CLI runtime and its `.env` is never committed or required by the CLI.

The synthetic Multistep and API bundle tests remain explicitly named `contract:`. They do not count as live-provider evidence.
