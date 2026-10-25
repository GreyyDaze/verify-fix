# Bundle Storage Plan (very simple)

**The rule:** keep the bundle **out of the user's project repo** (the customer repo being fixed) — and out of the verify-fix repo too. It is **proof, not code**.

*(Temporary exception: this verify-fix repo still keeps a few **sanitized** bundles in `fixtures/` and `incidents/` as test evidence while the test suite is migrated to synthetic bundles and a CI capture stage. They are not a pattern for users and are being retired.)*

---

## Why this is needed (the need)

1. **Pollution.** A bundle is a folder of evidence (manifest, HAR, traces, ZIP assets). Committing it fills the user's code repo with machine data, not code.

2. **Trust.** The bundle is the "exam paper" the candidate is graded against. If the candidate can edit it, the fix could be graded against fake evidence and wrongly PASS. So it must never come from the candidate's repo.

3. **Reproducibility.** The same bundle must give the same verdict. It needs to be stable and pinned (by fingerprint), wherever it is stored.

4. **Secrets.** Even sanitized, a bundle can carry sensitive request shapes. Keeping it out of the repo reduces leak risk.

5. **Short-lived need.** The bundle matters during the repair window (hours to a couple of weeks), not forever. Heavy durable storage is not required for the core problem.

6. **Fit for CI.** The gate needs a trusted copy at run time. A GitHub Actions artifact gives that without touching the repo; a fingerprint pin proves it was not swapped.

---

# Build Plan (very simple)

## Part A — On the developer's computer

**1.** Run the capture command.

**2.** Save the bundle **outside the user's repo** (e.g. `~/.verify-fix/bundles/<id>`).
→ Change the tool's default save path so it never lands in the project by default.

**3.** Add a `.gitignore` rule in the user's repo, just in case:
```
bundle-*/
incidents/
```

**4.** Save the bundle's **fingerprint** (SHA-256) for later.

---

## Part B — In CI: capture

**5.** CI runs the capture command (needs Checkly keys).

**6.** CI uploads the bundle as a **GitHub Actions artifact**.

**7.** CI records the **fingerprint**.

---

## Part C — In CI: gate

**8.** CI downloads the bundle **artifact**.

**9.** CI checks the fingerprint. Wrong → **stop (fail)**.

**10.** CI runs `verify-fix verify` on the fix.

**11.** **PASS** → allow. **FAILED / UNCERTAIN** → block.

---

## Part D — Safety rules

**12.** The bundle **never** comes from the candidate's code.

**13.** Missing bundle or missing fingerprint → **stop (fail)**, never PASS.

**14.** If the bundle must live longer than the artifact, move it to object storage (still keep the fingerprint).

---

## Order in one look

```
Developer:  capture → save outside user repo → gitignore → fingerprint
CI capture: capture → upload artifact → record fingerprint
CI gate:    download artifact → check fingerprint → verify → allow/block
```

---

# Customer gate contract

The reusable gate (`protected-gate.yml`) is project-neutral. A repository using
it supplies everything through the caller and its own configuration; no example
project path, check identity, bundle path, or provider is baked into the
workflow. Missing configuration fails closed.

## Caller (`gate.yml`, in the customer repo)

Triggers on `deployment_status` and calls the gate at an immutable commit. It
passes only deployment metadata; it never checks out or runs candidate code.

```yaml
on:
  deployment_status:

jobs:
  protected-gate:
    if: >-
      github.event.deployment_status.state == 'success' &&
      github.event.deployment_status.environment_url != ''
    uses: <owner>/verify-fix/.github/workflows/protected-gate.yml@<pinned-commit>
    with:
      verifier_ref: <pinned-commit>
      workflow_ref: <pinned-commit>
      deployment_id: ${{ format('{0}', github.event.deployment.id) }}
      deployment_sha: ${{ github.event.deployment.sha }}
      environment: ${{ github.event.deployment.environment }}
      environment_url: ${{ github.event.deployment_status.environment_url }}
    secrets: inherit
```

Pin `uses:` and `verifier_ref` to the same reviewed commit, and make the gate a
**required check** in the repository ruleset.

## Repository variables (`vars`)

| Variable | Required | Meaning |
|---|---|---|
| `CANDIDATE_PROJECT_PATH` | yes | Checkly project directory inside the repo (e.g. `web`). |
| `VERIFY_FIX_EXPECTED_CHECK_TYPE` | yes | Captured check type: `API`, `PLAYWRIGHT`, or `MULTI_STEP`. |
| `VERIFY_FIX_EXPECTED_CHECK_FILE` | yes | Check file path inside the project. |
| `VERIFY_FIX_EXPECTED_LOGICAL_ID` | yes | Stable logical check id. |
| `VERIFY_FIX_EXPECTED_MULTISTEP_RECORDING` | no | Failing recording path to assert for Multistep. |
| `VERIFY_FIX_BUNDLE_ARTIFACT` | yes | Artifact name from the capture run. |
| `VERIFY_FIX_BUNDLE_ARTIFACT_RUN` | yes | Capture run id. |
| `VERIFY_FIX_BUNDLE_DIGEST` | yes | Whole-bundle SHA-256 (64 lowercase hex). |
| `VERIFY_FIX_REQUIREMENTS_DIGEST` | no | Policy pin; empty reports `PROTECTED_POLICY_PIN_MISSING`. |
| `VERIFY_FIX_REQUIREMENTS_MODE` | no | `shadow` (default) or `enforce`. |
| `CHECKLY_ACCOUNT_ID` | yes | Checkly account id. |

## Repository secrets

| Secret | Meaning |
|---|---|
| `CHECKLY_API_KEY` | Checkly API key used by the cloud executor. |
| `TEST_USER`, `TEST_USER_US_EAST_1`, `TEST_USER_EU_WEST_1` | Browser identities. |
| `API_TOKEN` | API check token. |
| `MULTISTEP_USER_US_EAST_1`, `MULTISTEP_USER_EU_WEST_1` | Multistep identities. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Protected-target bypass (adapter-specific). |

## Job permissions

`contents: read`, `actions: read` (artifact download), `deployments: read`,
`pull-requests: read`.

## What the gate does

1. Resolves the pull request from the deployment; the candidate is the PR head.
2. Downloads the pinned artifact and recomputes the whole-bundle fingerprint.
3. Checks the manifest matches `VERIFY_FIX_EXPECTED_CHECK_*`.
4. Runs `verify-fix verify` against the live target.
5. Deploys the checks only on `PASS`.

A missing artifact, run id, fingerprint, or check identity — or any mismatch —
stops the gate. It never falls back to a committed bundle path.

## Deployment metadata (any provider)

`--target-metadata` is a small JSON file written by the CI, not by the
verifier:

```json
{
  "provider": "kubernetes",
  "deploymentId": "rollout-42",
  "revision": "<exact 40-hex deployed commit>",
  "url": "https://preview.example",
  "environment": "preview"
}
```

`provider` is free-form (`vercel`, `netlify`, `fly`, `kubernetes`,
`self-hosted`, …). The gate fails closed unless `revision` equals both
`--target-revision` and the candidate HEAD, and `url` equals `--target`.

## Non-GitHub and non-Vercel CI

`gate.yml` + `protected-gate.yml` are the GitHub Actions / Vercel reference
adapter, not the architecture. Any CI can call `scripts/ci-gate.sh`, which
takes the bundle, the exact candidate SHA, deployment metadata, and Checkly
credentials, then runs:

```
verify-fix verify --candidate-revision <sha> --base <ref> --executor hybrid --cloud-approved
```

and exits non-zero unless the report is `PASS` and the candidate is
gate-eligible. A non-PR candidate is accepted from any Git host: the checkout
must be at the exact 40-hex SHA with a clean tree, and the deployment metadata
must name the same revision. `--pr` remains a GitHub convenience that produces
the same immutable identity.

### Adapter examples

The same script works everywhere; only environment variables differ.

```bash
# GitLab CI (.gitlab-ci.yml)
gate:
  script:
    - ./scripts/ci-gate.sh

# Bitbucket Pipelines
#   - step: { script: ["./scripts/ci-gate.sh"] }

# Jenkins
#   sh './scripts/ci-gate.sh'

# Local
VF_BUNDLE_DIR="$HOME/.verify-fix/bundles/booking" \
VF_BUNDLE_DIGEST="$(node .github/helpers/bundle-digest.mjs "$VF_BUNDLE_DIR")" \
VF_CANDIDATE_PROJECT="$PWD/web" \
VF_BASE=origin/main \
VF_CANDIDATE_REVISION="$(git -C "$PWD" rev-parse HEAD)" \
VF_TARGET=https://preview.example \
VF_TARGET_REVISION="$(git -C "$PWD" rev-parse HEAD)" \
VF_TARGET_METADATA=./deployment.json \
./scripts/ci-gate.sh
```
