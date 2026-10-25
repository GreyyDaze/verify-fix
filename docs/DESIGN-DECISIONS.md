# Design Decisions

This document records the key architectural choices, their rationale, and tradeoffs. These are not implementation details — they are the decisions that shape the system's behavior and guarantees.

---

## Evidence & Trust

### 1. Bundles Are Proof, Not Code

**Decision:** Incident bundles are stored outside the repository (GitHub Actions artifact, local filesystem, or object store). They are pinned by SHA-256 fingerprint. No captured bundle is committed.

**Rationale:**
- **Trust:** The bundle is the "exam paper." If the candidate can edit it, a silencing patch could be graded against fake evidence and wrongly PASS.
- **Reproducibility:** The same bundle must yield the same verdict. A fingerprint proves the bundle wasn't swapped.
- **Secrets:** Even sanitized bundles can carry sensitive request shapes. Keeping them out of the repo reduces leak risk.
- **Short-lived:** Bundles matter during the repair window (hours to weeks), not forever. Heavy durable storage is unnecessary.

**Tradeoff:** Requires CI to manage artifact upload/download and fingerprint verification. The gate (`scripts/ci-gate.sh`) handles this explicitly.

---

## Policy & Requirements

### 2. Sealed Requirements from Effective Config

**Decision:** Protected requirements are derived from the *live Checkly API* (effective check configuration) plus the captured result, then frozen into the bundle. The candidate's source files are never trusted for policy.

**Rationale:**
- An agent can edit check source files to claim different requirements (e.g., remove an assertion, change `doubleCheck`). The real configuration is what Checkly executes.
- The static gate runs *before* any execution, comparing the candidate's effective config against the sealed requirements. Mismatch → `FAILED` immediately.

**Tradeoff:** Requires a live Checkly API call at capture time. The bundle capture command (`verify-fix bundle`) performs this.

### 3. Shadow → Migration → Enforcement Rollout

**Decision:** Protected requirements default to `shadow` mode (report-only). Explicit opt-in to `migration` (versioned bundles) then `enforce` (block PRs).

**Rationale:**
- Rolling out a static gate that blocks PRs on day one is risky. Shadow mode lets teams see what *would* block without breaking workflow.
- Migration pins bundle digests, ensuring requirements are stable before enforcement.
- The CLI default is `enforce` (code-level), but the gate adapter passes `--requirements-mode shadow` unless overridden.

**Tradeoff:** Requires discipline to advance stages. Documented in `USER-GUIDE.md`.

---

## Execution & Identity

### 4. Scene Proxy as Single Execution Abstraction

**Decision:** A single scene proxy (`src/execution/scene/proxy.ts`) handles all execution modes:
- `live` — real requests to the deployment target
- `replay:<har>` — deterministic replay from captured HAR
- `inject:<method> <path> → <status>` — fault injection

**Rationale:**
- One abstraction covers reproduction (live), regression (replay), and detection (inject).
- Concurrency control is centralized: one listener per concurrent run, lockstep interleaving.
- Executors (Playwright, Checkly cloud, hybrid) all delegate to the proxy for request/response handling.

**Tradeoff:** Proxy adds latency and complexity. Mitigated by bounded body sizes, strict timeouts, and optional bypass for browser assets.

### 5. Multistep Identity Bound to Construct, Not Region

**Decision:** Multistep check identity is bound to the captured construct (logical ID + construct source), not the runtime region. Regional accounts are mapped via the `REGION` environment variable at runtime.

**Rationale:**
- Checkly's Multistep runtime provides `REGION` (not `CHECKLY_REGION`). The construct defines the check; the region selects the account.
- This matches Checkly's documented model and avoids hardcoding region lists in the tool.

**Tradeoff:** Requires the capture to record the construct source and logical ID correctly. The bundle capture does this.

---

## Verdict & Oracle

### 6. No LLM Oracle — Deterministic Rules Only

**Decision:** The verdict is produced by deterministic rules, not an LLM. Exit codes: `0` (PASS), `1` (FAILED), `2` (UNCERTAIN).

**Rules:**
- **Assertion identity:** Every `expect(...)` in the original check must have a corresponding assertion in the candidate. Removed/weakened/caught assertions → FAILED.
- **Evidence binding:** Candidate must exercise the same requests (method, path, ordered). Zero requests → UNCERTAIN (vacuous).
- **Oracle strength:** Repeated runs (default 20) must agree. Disagreement → UNCERTAIN.
- **Mutation gate:** Four broken mutants of the candidate must all be rejected. If any mutant passes → FAILED (oracle too weak).
- **Regression:** Every affected sibling monitor (via file→monitor mapping) gets a REGRESSION scene.

**Rationale:** Deterministic, auditable, CI-friendly. No prompt engineering, no non-determinism, no cost-per-decision.

**Tradeoff:** Rules must be complete. The codebase is the specification.

---

## Integration

### 7. Provider-Neutral Gate

**Decision:** The gate is a standalone POSIX script (`scripts/ci-gate.sh`) taking environment variables:
- Bundle path + fingerprint
- Exact candidate revision (40-hex SHA)
- Deployment metadata JSON (`provider`, `deploymentId`, `revision`, `url`, `environment`)
- Checkly credentials

**Rationale:**
- Works in GitHub Actions, GitLab CI, Jenkins, Bitbucket, local shell — any environment that can supply the inputs.
- GitHub Actions is one adapter (`.github/workflows/ci.yml` for repo CI, example CI in `examples/slots-booking/`). The architecture doesn't depend on it.

**Tradeoff:** Caller must wire the environment correctly. The script fails closed with explicit error messages for missing inputs.

---

## Related Principles (not architectural decisions)

These are testing and reference conventions — important, but they don't shape the system's behavior or guarantees. They live in their respective docs:

| Principle | Documented In |
|---|---|
| No committed bundles in tests | `TESTING.md` — Principle 1 |
| Example project uses Checkly conventions | `USER-GUIDE.md` — Example Project section |
| Real provider acceptance is opt-in | `ACCEPTANCE.md` — Prerequisites |