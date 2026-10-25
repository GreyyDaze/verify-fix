#!/usr/bin/env bash
# Provider-neutral gate adapter.
#
# Grades one immutable candidate revision against a captured bundle and a live
# deployment. It knows nothing about GitHub, Vercel, or any other host: the CI
# supplies the bundle, the exact revision, and the deployment metadata.
#
# Required:
#   VF_BUNDLE_DIR          local directory of the captured bundle
#   VF_BUNDLE_DIGEST       whole-bundle SHA-256 (64 lowercase hex)
#   VF_CANDIDATE_PROJECT   path to the Checkly project in the candidate checkout
#   VF_BASE                base git ref used to describe changes
#   VF_CANDIDATE_REVISION  exact 40-hex commit SHA, checked out with a clean tree
#   VF_TARGET              deployment origin (bare http(s) origin)
#   VF_TARGET_REVISION     exact deployment revision (must equal the candidate SHA)
#   VF_TARGET_METADATA     JSON: {provider,deploymentId,revision,url,environment?}
#   CHECKLY_API_KEY, CHECKLY_ACCOUNT_ID
#
# Optional:
#   VF_PROJECT, VF_ENV_FILE, VF_ENV_NAME, VF_REPORT_JSON, VF_REPORT_MARKDOWN,
#   VF_REQUIREMENTS_MODE, VF_REQUIREMENTS_DIGEST, VF_CLI
set -euo pipefail

fail() {
  echo "ci-gate: $*" >&2
  exit 2
}

for name in VF_BUNDLE_DIR VF_BUNDLE_DIGEST VF_CANDIDATE_PROJECT VF_BASE \
  VF_CANDIDATE_REVISION VF_TARGET VF_TARGET_REVISION VF_TARGET_METADATA \
  CHECKLY_API_KEY CHECKLY_ACCOUNT_ID; do
  [[ -n "${!name:-}" ]] || fail "$name is required"
done

[[ -d "$VF_BUNDLE_DIR" ]] || fail "VF_BUNDLE_DIR is not a directory"
[[ -f "$VF_TARGET_METADATA" ]] || fail "VF_TARGET_METADATA is not a file"
[[ "$VF_BUNDLE_DIGEST" =~ ^[a-f0-9]{64}$ ]] || fail "VF_BUNDLE_DIGEST must be 64-hex"
[[ "$VF_CANDIDATE_REVISION" =~ ^[0-9a-f]{40}$ ]] || fail "VF_CANDIDATE_REVISION must be 40-hex"
[[ "$VF_TARGET_REVISION" == "$VF_CANDIDATE_REVISION" ]] || fail "VF_TARGET_REVISION must equal VF_CANDIDATE_REVISION"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli="${VF_CLI:-$script_dir/../bin/verify-fix}"
report_json="${VF_REPORT_JSON:-$(mktemp "${TMPDIR:-/tmp}/verify-fix-ci-report.XXXXXX")}"

args=(verify
  --bundle "$VF_BUNDLE_DIR"
  --bundle-digest "$VF_BUNDLE_DIGEST"
  --candidate-project "$VF_CANDIDATE_PROJECT"
  --candidate-revision "$VF_CANDIDATE_REVISION"
  --base "$VF_BASE"
  --target "$VF_TARGET"
  --target-revision "$VF_TARGET_REVISION"
  --target-metadata "$VF_TARGET_METADATA"
  --cloud-approved
  --executor hybrid
  --report-json "$report_json")
[[ -z "${VF_PROJECT:-}" ]] || args+=(--project "$VF_PROJECT")
[[ -z "${VF_ENV_FILE:-}" ]] || args+=(--env-file "$VF_ENV_FILE")
[[ -z "${VF_ENV_NAME:-}" ]] || args+=(--env-name "$VF_ENV_NAME")
[[ -z "${VF_REQUIREMENTS_MODE:-}" ]] || args+=(--requirements-mode "$VF_REQUIREMENTS_MODE")
[[ -z "${VF_REQUIREMENTS_DIGEST:-}" ]] || args+=(--requirements-digest "$VF_REQUIREMENTS_DIGEST")
[[ -z "${VF_REPORT_MARKDOWN:-}" ]] || args+=(--report-markdown "$VF_REPORT_MARKDOWN")

mkdir -p "$(dirname "$report_json")"
node "$cli" "${args[@]}"

# Fail closed: only a PASS bound to the exact revision is a gate result.
read_field() {
  node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],r);process.stdout.write(String(v))' "$report_json" "$1"
}

verdict="$(read_field verdict)"
[[ "$verdict" == "PASS" ]] || fail "verdict is $verdict, not PASS"
eligible="$(read_field targetBinding.gateEligible)"
[[ "$eligible" == "true" ]] || fail "candidate is not gate-eligible"
echo "ci-gate: PASS (gate-eligible)"
