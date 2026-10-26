# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-26

### Added

- `verify-fix bundle` — captures a failing Checkly check plus a passing baseline into a sanitized, fingerprinted v3 evidence bundle.
- `verify-fix verify` — grades a candidate patch against a captured bundle using sealed requirements, evidence binding, oracle strength, mutation rejection, and sibling regression.
- `verify-fix measure` — measures determinism across repeated local runs and writes oracle strength into the bundle manifest.
- `verify-fix cost-report` — aggregates saved verification reports by candidate and verdict.
- `verify-fix init` — prepares an existing Checkly project for verify-fix without creating or copying an example.
- `verify-fix --version` / `-V` — prints the CLI version for toolchain pinning.
- Provider-neutral CI gate: `scripts/ci-gate.sh` and a composite GitHub Action (`action.yml`).
- Optional `VF_CLI_VERSION` gate check that refuses to run on a version mismatch.
- Example project at `examples/slots-booking/` using Checkly's `__checks__/` convention.

[Unreleased]: https://github.com/GreyyDaze/verify-fix/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/GreyyDaze/verify-fix/releases/tag/v0.1.0
