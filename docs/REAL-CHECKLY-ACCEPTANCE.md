# Real Checkly acceptance

`npm test` remains local and credential-free. The commands below are opt-in live acceptance checks and require Checkly credentials plus private environment values.

## Capture real Checkly evidence

```bash
VERIFY_FIX_ACCEPTANCE_CHECK_ID=c68a06fe-6062-4d02-b31c-9ab4331f8cbe \
VERIFY_FIX_ACCEPTANCE_RESULT_ID=01a0e54e-298a-79b4-befe-5d4416ead2e5 \
VERIFY_FIX_ACCEPTANCE_PASS_RESULT_ID=01a0da9c-a20d-779d-b580-1858634db851 \
VERIFY_FIX_ACCEPTANCE_PROJECT=examples/slots-booking/web \
npm run test:checkly-acceptance
```

This authenticates with Checkly, confirms the requested check and result identities, pages result history, downloads and validates the selected Multistep assets, binds both result captures, and writes a sanitized bundle to a temporary directory. It does not run the verifier or claim that a repair passed.

## Run the full Multistep verification acceptance

Provide a private, mode-`0600` environment file for the live app. It must contain the two `MULTISTEP_USER_*` values and the approved `CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET` value. The Checkly API key and account ID must also be available through the normal Checkly credential mechanism.

```bash
VERIFY_FIX_ACCEPTANCE_CHECK_ID=c68a06fe-6062-4d02-b31c-9ab4331f8cbe \
VERIFY_FIX_ACCEPTANCE_RESULT_ID=01a0e54e-298a-79b4-befe-5d4416ead2e5 \
VERIFY_FIX_ACCEPTANCE_PASS_RESULT_ID=01a0da9c-a20d-779d-b580-1858634db851 \
VERIFY_FIX_ACCEPTANCE_TARGET=https://slots-booking-verify-fix.vercel.app \
VERIFY_FIX_ACCEPTANCE_ENV_FILE=/absolute/path/to/private/checkly.env \
VERIFY_FIX_ACCEPTANCE_PATCH=fixtures/patches/slots-booking-multistep-nested-response \
VERIFY_FIX_ACCEPTANCE_PROJECT=examples/slots-booking/web \
npm run test:checkly:verify
```

The command captures the real failing and passing Checkly results again, verifies their bound Multistep evidence, measures 20 repetitions of the original check against the live application, then invokes the actual `verify-fix verify` CLI for:

- the known nested-response repair: expected `PASS` / exit 0;
- the unchanged original check: expected `FAILED` / exit 1;
- the valid repair without a target: expected `UNCERTAIN` / exit 2.

It writes JSON and Markdown reports under the temporary evidence bundle. The repaired check contract is evaluated against the unchanged live app; this acceptance command does not edit or deploy the Checkly check.

Do not describe bundle capture alone as full acceptance. Full acceptance requires this second command to finish successfully. Real Checkly evidence is separate from unit, contract, synthetic Multistep, local-app, and CLI E2E test evidence.