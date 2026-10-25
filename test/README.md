# Test layout

Folders group tests by responsibility, one level deep:

```
test/
├── candidate/    candidate identity and revision intake
├── capture/      Checkly client, bundle capture, trace conversion
├── checks/       check source models (Multistep today), fixtures, helpers
├── cli/          init and local measurement commands
├── execution/    sandbox, scene executor, hybrid executor
├── policy/       protected requirements and Playwright model
├── report/       cost accounting
├── workflow/     CI gates and repository workflow
└── helpers/      shared test-only utilities
```

A test lives next to the responsibility it exercises, not next to the example
project. The suite keeps no captured or synthetic bundle: tests that would need
one are not part of the suite.
