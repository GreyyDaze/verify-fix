# Bundle Storage Plan (very simple)

**The rule:** keep the bundle **out of the user's project repo** (the customer repo being fixed) — and out of the verify-fix repo too. It is **proof, not code**.

*(This repository follows that rule: no captured bundle is committed. Tests
that need evidence build it in temporary directories from code and synthetic
results. A developer who captures a real incident keeps it outside the repo or
under the ignored `incidents/` directory.)*

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

The gate lives in `scripts/ci-gate.sh`, a provider-neutral adapter. A
repository supplies everything through environment variables and its own
configuration; no example project path, check identity, bundle path, or
provider is baked into it. Missing configuration fails closed.

Run it from any CI, or from a shell, after the bundle has been captured and
stored outside the repository. Pin the script (and the CLI it calls) to a
reviewed commit, and make its job a **required check** in the repository
ruleset.

## Inputs

| Variable | Required | Meaning |
|---|---|---|
| `VF_CANDIDATE_PROJECT` | yes | Checkly project directory inside the candidate checkout. |
| `VF_BUNDLE_DIR` | yes | Local bundle directory, stored outside the repository. |
| `VF_BUNDLE_DIGEST` | yes | Whole-bundle SHA-256 (64 lowercase hex). |
| `VF_CANDIDATE_REVISION` | yes | Exact 40-hex candidate SHA, checked out with a clean tree. |
| `VF_BASE` | yes | Base Git ref used to describe changes. |
| `VF_TARGET` | yes | Deployment origin (bare http(s) origin). |
| `VF_TARGET_REVISION` | yes | Deployed revision; must equal `VF_CANDIDATE_REVISION`. |
| `VF_TARGET_METADATA` | yes | Deployment metadata file (see below). |
| `CHECKLY_ACCOUNT_ID` | yes | Checkly account id. |
| `VF_REQUIREMENTS_DIGEST` | no | Policy pin; empty reports `PROTECTED_POLICY_PIN_MISSING`. |
| `VF_REQUIREMENTS_MODE` | no | `shadow` (default) or `enforce`. |
| `VF_ENV_FILE`, `VF_ENV_NAME` | no | Checkly environment inputs. |
| `VF_PROJECT` | no | Checkly project name override. |

## Secrets

| Secret | Meaning |
|---|---|
| `CHECKLY_API_KEY` | Checkly API key used by the cloud executor. |
| `TEST_USER`, `TEST_USER_US_EAST_1`, `TEST_USER_EU_CENTRAL_1` | Browser identities. |
| `API_TOKEN` | API check token. |
| `MULTISTEP_USER_US_EAST_1`, `MULTISTEP_USER_EU_CENTRAL_1` | Multistep identities. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Protected-target bypass (adapter-specific). |

## What the gate does

1. Requires an exact candidate revision and matching deployment metadata.
2. Recomputes the whole-bundle fingerprint and rejects a mismatch.
3. Runs `verify-fix verify` against the live target.
4. Exits non-zero unless the verdict is `PASS` and the candidate is
   gate-eligible.

A missing bundle, fingerprint, revision, or deployment identity — or any
mismatch — stops the gate. It never falls back to a committed bundle path.

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

`scripts/ci-gate.sh` is the reference adapter, not the architecture. It takes
the bundle, the exact candidate SHA, deployment metadata, and Checkly
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
VF_BUNDLE_DIGEST="<fingerprint printed by the capture command>" \
VF_CANDIDATE_PROJECT="$PWD/web" \
VF_BASE=origin/main \
VF_CANDIDATE_REVISION="$(git -C "$PWD" rev-parse HEAD)" \
VF_TARGET=https://preview.example \
VF_TARGET_REVISION="$(git -C "$PWD" rev-parse HEAD)" \
VF_TARGET_METADATA=./deployment.json \
./scripts/ci-gate.sh
```
