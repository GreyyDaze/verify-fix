# Test layout

Folders mirror `src/` and group tests by responsibility:

```
test/
├── candidate/        src/candidate
├── capture/          src/capture (archive, bundle)
├── checks/           src/checks (multistep; fixtures and helpers live here)
├── cli/              src/cli
├── execution/        src/execution (executor, sandbox, scene)
├── policy/           src/policy
├── report/           src/report
├── workflow/         CI gates and repository workflow tests
└── helpers/          shared test-only utilities
```

A test lives next to the responsibility it exercises, not next to the example
project. The suite keeps no captured or synthetic bundle: tests that would need
one are not part of the suite.
