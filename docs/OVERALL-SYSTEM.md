# Verify-Fix: Overall System

## 1. Problem

An AI agent can change a monitoring check so the check becomes green without fixing the real application.

Examples:
- remove the failing assertion
- weaken the expected value
- change the monitored location or configuration
- catch and ignore the error
- hard-code a value that makes the check pass
- change retry or timeout settings so the failure disappears
- make the check test something different from what it originally protected

The real question is:

> Did the candidate fix the application problem that caused the original monitoring failure, while keeping the original monitoring contract intact?

Verify-Fix answers that question without using an LLM as the oracle.

## 2. Solution

The system separates the job into two parts:

1. Capture what actually failed.
2. Use that protected evidence to test the proposed repair.

```
Checkly incident
      ↓
Incident bundle
      ↓
Original failure + passing baseline + source + evidence
      ↓
Reproduce the failure against the target
      ↓
Run controlled verification experiments
      ↓
Check the candidate did not weaken the monitoring contract
      ↓
Run cloud verification when required
      ↓
PASS / FAILED / UNCERTAIN
```

The verifier does not decide what a correct fix should be. It checks whether the candidate satisfies evidence already established by the incident.

## 3. Solution divided into features

### 3.1 Incident capture

**Problem:** The verifier needs a trustworthy description of the real incident.

**Solution:** `verify-fix bundle` talks directly to Checkly and captures the check definition, configuration, result history, failing result, passing result, result details, traces or Multistep assets, error groups, optional RCA, source files, assertions, scenes, and provenance.

**Main code:**
- src/cli.ts
- src/bundle/build.ts
- src/bundle/manifest.ts
- src/bundle/sanitize.ts
- src/bundle/types.ts
- src/checkly/client.ts
- src/checkly/credentials.ts

**Tests:** bundle, client, HTTP, manifest, trace, and CLI integration tests.

**Real-provider evidence:** the external authenticated Checkly bundle.

### 3.2 Result history and baseline selection

**Problem:** A failure alone does not tell us what the check normally does.

**Solution:** Fetch FINAL results, paginate within the requested history limit, find the failing result, find a suitable passing result, use overlapping runs where required, and never manufacture a passing result.

**Main code:** src/bundle/build.ts, src/checkly/client.ts, src/cli.ts.

**To be fixed:** automated tests use synthetic result data. They prove the selection algorithm, not the current live Checkly response shape. Real authenticated acceptance must cover this.

### 3.3 Source and identity binding

**Problem:** The source being verified must correspond to the deployed Checkly check.

**Solution:** Bind the Checkly check, logical ID, deployed configuration, project source, Multistep construct, entrypoint, and imported source closure. Reject unsafe paths, oversized files, symlinks, source mismatches, and configuration mismatches.

**Main code:** src/multistep/source.ts, src/multistep/files.ts, src/multistep/identity.ts, src/candidate/check-identity.ts, src/candidate/revision.ts.

### 3.4 Evidence sanitization and secret protection

**Problem:** Monitoring evidence can contain credentials, cookies, authorization headers, signed URLs, request bodies, and environment values.

**Solution:** Sanitize before persistence. Bound downloads and archives. Hash remote evidence for provenance. Keep Checkly authentication separate from external or presigned asset URLs. Do not log signed URLs.

**Main code:** src/checkly/client.ts, src/bundle/sanitize.ts, src/api/recording.ts, src/multistep/sanitize.ts, src/trace/zip.ts.

### 3.5 Multistep evidence acquisition

**Problem:** Multistep checks do not use a normal Playwright trace as their primary evidence. Forcing a trace filter can hide the useful result assets.

**Solution:** Fetch the complete result manifest, select the known evidence by asset/archive name, download with bounds, validate the manifest and archive, normalize the evidence, and reject partial capture.

**Main code:** src/bundle/build.ts, src/multistep/capture.ts, src/multistep/normalize.ts, src/multistep/transaction.ts, src/multistep/bundle-evidence.ts, src/multistep/raw-evidence.ts, src/multistep/sanitize.ts.

**Tests:** remote manifest selection, bounded download, archive parsing, and validation-category contract tests.

**Important:** These tests use provider-shaped synthetic data. They are not real-provider proof. The external authenticated bundle is the real-provider acceptance evidence.

### 3.6 Failure reproduction

**Problem:** A candidate cannot be considered fixed merely because the edited check passes.

**Solution:** Reproduce the original failure against the target application first. Verification scenes describe the expected behavior and the evidence needed to prove the observation.

**Main code:** src/scene, src/executor/scene.ts, src/multistep/executor.ts.

**Tests:** the main verification suite runs the real CLI against the seeded application and checks both failing and good candidates.

### 3.7 Candidate integrity

**Problem:** The candidate can change more than the intended fix.

**Solution:** Track Git revision, dirty state, staged/unstaged changes, untracked files, PR revision, project path, and deployment metadata. Bind the candidate to the target revision.

**Main code:** src/candidate/revision.ts, src/candidate/check-identity.ts, src/patch.ts.

### 3.8 Mutation and adequacy testing

**Problem:** A verifier can accidentally accept a weak oracle.

**Solution:** Apply controlled bad changes and require the verification scenes to detect them. Examples include weakened assertions, removed assertions, changed account/location, retry-only changes, timeout masking, swallowed errors, and hard-coded results.

**Main code:** src/mutation.ts, src/adequacy/adequacy.ts, src/assertion/*.

### 3.9 Hybrid and cloud verification

**Problem:** Some failures only become meaningful in the cloud monitoring environment.

**Solution:** Combine local deterministic verification with protected Checkly execution. Bind the execution to the expected deployment and revision. Cloud execution happens only after the required gates pass.

**Main code:** src/executor/hybrid.ts, src/executor/checkly.ts, src/executor/checkly-cli.ts, src/multistep/executor.ts, src/multistep/accounts.ts, src/multistep/policy.ts.

### 3.10 Decision and reporting

**Problem:** The system needs one deterministic answer with enough evidence to explain it.

**Solution:** Produce PASS, FAILED, or UNCERTAIN. Exit codes are 0, 1, and 2 respectively.

**Main code:** src/decision/decision.ts, src/report/report.ts, src/cost-report.ts, src/verify.ts.

## 4. Whole system in plain English

1. Get the real failed monitoring result from Checkly.
2. Save enough evidence to describe what failed.
3. Find a real healthy result when one exists.
4. Bind the evidence to the actual check and source.
5. Reproduce the original failure against the application.
6. Run the candidate fix against the same problem.
7. Check that the candidate did not simply weaken or remove the monitoring contract.
8. Use cloud verification when local evidence alone is not enough.
9. Return PASS only when the required evidence exists.

Otherwise return FAILED or UNCERTAIN.

## 5. Testing model

### Level 1: Unit and contract tests

These test exact behavior with fake HTTP responses, synthetic Checkly manifests, synthetic result history, ZIP fixtures, and validation cases.

They are useful and necessary, but they are not real-provider proof.

### Level 2: CLI integration tests

Some tests actually spawn the CLI and execute production code against local application or local provider stand-ins.

They prove that multiple production components work together. They do not prove that Checkly itself currently returns the same data.

### Level 3: Real application tests

The seeded application is actually executed. The mutation suite checks that known bad changes are detected and known good changes pass.

### Level 4: Real Checkly acceptance

The CLI is run with real Checkly credentials against a real Checkly check and real result history/assets.

The external authenticated bundle is this kind of evidence.

## 6. What is not currently satisfying the desired testing rule

The repository does not have one automated npm test suite where every test launches the real CLI, avoids provider mocks, talks to real Checkly, talks to a real deployed target, and verifies the complete production path.

The current test suite intentionally mixes fast contract tests with integration tests.

### To be fixed

1. Clearly label mocked-provider tests as contract tests, not real-provider proof.
2. Keep a documented real-provider acceptance procedure for bundle capture.
3. Add a documented real-provider acceptance procedure for the complete verify path.
4. Keep the normal npm test suite deterministic and credential-free.
5. Keep real-provider acceptance separate from the fast suite.
6. Do not use synthetic assets as evidence that Checkly itself returned those assets.

## 7. Core invariant

> A PASS must be supported by evidence that the original monitoring contract was exercised against the intended application and that the candidate did not merely make the check easier to satisfy.

Therefore:

```
PASS =
original problem reproduced
+ candidate satisfies the required behavior
+ monitoring contract still matters
+ target/revision identity is correct
+ required evidence is real and sufficient
```

If a required part cannot be established, the correct result is UNCERTAIN, not PASS.

## 8. Production code, tests, and acceptance evidence are different

**Production code** implements the provider integration, evidence capture, source binding, verification, and decision logic.

**Tests** prove specific invariants and edge cases.

**Real acceptance** proves that the implementation matches the real provider.

A synthetic test must never be described as a replacement for real-provider acceptance.