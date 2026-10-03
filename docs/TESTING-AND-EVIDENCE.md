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

These are important because they test failure boundaries deterministically.

They do not prove that the live Checkly API currently returns those exact shapes.

## 3. Current CLI integration examples

Important tests include:

- test/verify.spec.ts
- test/bundle/cli-http.spec.ts
- test/package/external-customer.spec.ts
- test/checkly-sandbox.spec.ts
- test/playwright-sandbox.spec.ts

These tests exercise real production CLI code instead of calling only individual helper functions.

Some deliberately replace external services with local stand-ins. That is useful for deterministic testing but must not be described as a live-provider test.

## 4. Real application evidence

The seeded slots-booking application is used to reproduce real application behavior.

The verification tests check things such as:
- the original failure is actually observed
- the verifier contacts the application
- a good repair passes
- known bad repairs fail
- weakened assertions are detected
- configuration-only or retry-only changes do not create a false PASS
- repeated observations remain deterministic where required

This is stronger than testing only parsed objects because the verifier actually exercises application behavior.

## 5. Real Checkly acceptance

The real provider acceptance path should be treated separately from npm test.

Required evidence:

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
```

For the current Multistep work, the external authenticated bundle is the acceptance evidence.

## 6. What the normal test suite should not claim

The following statements are too strong for mocked-provider tests:

- Checkly returned the expected manifest.
- Checkly accepted the request.
- the live Checkly asset endpoint works.
- the provider's current response shape is proven.

Correct wording:

- the provider contract is tested with a synthetic manifest.
- the HTTP client behavior is tested with a controlled response.
- the CLI path is tested with a local provider stand-in.
- live Checkly acceptance was verified separately.

## 7. Gaps to fix

### Gap 1: No permanent live-provider automated gate

The normal test suite does not use real Checkly credentials. This is good for deterministic development, but there should be a separate acceptance command or protected workflow for live-provider verification.

### Gap 2: Bundle acceptance and verify acceptance should be separate

Capturing a real bundle proves provider acquisition. It does not automatically prove that the full candidate verification path passes against a real deployed target.

Both should have explicit acceptance procedures.

### Gap 3: Test names should communicate evidence level

Tests using fakeFetch, synthetic manifests, or local Checkly stand-ins should make that clear in the test name or file documentation.

### Gap 4: Do not make live credentials part of npm test

Real provider tests should not run on every developer test command. They should be an explicit acceptance step with protected credentials and controlled targets.

## 8. Acceptance standard

A feature is fully accepted only when both are true:

1. deterministic tests prove the implementation invariants
2. the real-provider acceptance path proves the external integration

Neither replaces the other.

## 9. Evidence hierarchy

From lowest to highest external realism:

1. pure unit test
2. synthetic provider contract test
3. CLI integration against local stand-in
4. CLI against a real local/deployed application
5. authenticated real-provider acceptance
6. complete protected production verification

A lower level can prove a specific implementation property. It cannot automatically prove the levels above it.

## 10. Dedicated real Checkly acceptance command

The repository now has an explicit live-provider command:

```bash
VERIFY_FIX_ACCEPTANCE_CHECK_ID=<real-check-id> npm run test:checkly
```

Optional inputs:

```bash
VERIFY_FIX_ACCEPTANCE_PROJECT=<checkly-project-dir>
VERIFY_FIX_ACCEPTANCE_RESULT_ID=<specific-failing-result-id>
VERIFY_FIX_ACCEPTANCE_OUT=<output-dir>
```

The command uses real Checkly credentials from `CHECKLY_API_KEY` + `CHECKLY_ACCOUNT_ID`, or the credentials saved by `checkly login`.

It performs these checks:

1. fetches the named check from Checkly
2. fetches real FINAL result history
3. requires a real failing and passing result
4. fetches the result evidence through the production bundle path
5. requires the expected recording type for the check
6. writes the resulting bundle to the requested output directory
7. prints the result IDs, locations, history counts, asset count, and recording paths

This command is intentionally outside `npm test`. It is the explicit provider-acceptance gate and must use controlled credentials and a controlled Checkly check.

The synthetic Multistep and API bundle tests are now explicitly named `contract:` and remain deterministic mechanics tests. They do not count as live-provider evidence.
