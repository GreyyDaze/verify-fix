# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a vulnerability

Do **not** open a public issue for a security problem.

Report it privately through GitHub's [private vulnerability reporting](https://github.com/GreyyDaze/verify-fix/security/advisories/new), or email the maintainer if that is unavailable.

Please include:

- What the issue is and which component is affected
- The command or input that triggers it
- Whether credentials, bundle contents, or verdict integrity are at risk
- A minimal reproduction, if you have one

You can expect an acknowledgement within a few days and a coordinated disclosure timeline.

## What counts as a security issue

- A way for candidate code to influence the verdict beyond the documented policy rules
- Bundle tampering that is not detected by the fingerprint check
- Credential or secret leakage into bundles, reports, or logs
- A gate bypass that produces exit code `0` without a gate-eligible `PASS`
- Path traversal, symlink, or file-type bypasses in bundle capture or loading
- Arbitrary code execution outside the documented sandbox

## Design commitments

- Bundles never live inside the candidate repository.
- Secrets are read from the environment and are never written to bundles or reports.
- The gate fails closed: missing inputs, fingerprint mismatches, and missing identity are configuration errors, never passes.
- Requirements are sealed from the live Checkly API before candidate code runs.

## Disclosure

Once a fix is available, the issue is described in the changelog and credited to the reporter unless they prefer to stay anonymous.
