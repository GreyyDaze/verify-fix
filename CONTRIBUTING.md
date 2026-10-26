# Contributing

Thanks for taking a look at `verify-fix`.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Setup

```bash
git clone https://github.com/GreyyDaze/verify-fix.git
cd verify-fix
npm ci --ignore-scripts
```

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run build
```

All three must pass. CI runs the same commands on Node 22 and 24, plus a package smoke test.

## Ground rules

- **No captured bundles in tests.** Tests build disposable bundles from synthetic inputs in temporary directories. A committed bundle couples tests to one incident and proves nothing generic.
- **No LLM in the verdict path.** Verdicts are deterministic rules with fixed exit codes (`0` PASS, `1` FAILED, `2` UNCERTAIN).
- **Evidence is proof, not code.** Bundles are stored outside the repository and pinned by a SHA-256 fingerprint.
- **Tests are grouped by responsibility**, one level below `test/` (`policy/`, `checks/`, `evidence/`, `execution/`, `candidate/`, `workflow/`, `cli/`).
- **Real-provider acceptance is opt-in.** `npm run test:checkly-acceptance` and `npm run test:checkly:verify` need Checkly credentials and are not part of CI.

## Commit messages

Use a short imperative subject line, optionally scoped:

```
fix(policy): reject assertions nested under try/catch
docs: document the gate environment variables
test(execution): cover replay mode with a truncated HAR
```

## Reporting bugs

Open an issue with the command you ran, the expected verdict, the actual verdict, and the report JSON (redact bundle contents and credentials). For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing, you agree that your contribution is licensed under the MIT License.
