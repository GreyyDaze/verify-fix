import assert from "node:assert/strict";
import test from "node:test";

import {
  MANUAL_STABLE_STATUS_MARKER,
  VERCEL_APP_SLUG,
  mapStatusProvenance,
  normalizeHttpsOrigin,
  resolveUrlRoles,
  validateDeploymentRecord,
  validatePreflightInputs,
} from "../../.github/helpers/deployment-url-roles.mjs";

const SHA = "a".repeat(40);
const VERIFICATION_URL = "https://deploy-slug.vercel.app";
// Stage 2: the stable test URL is a bare monitoring origin (no path).
const MONITORING_URL = "https://monitoring.example.org";

// Raw GitHub REST deployment-status creator objects: login + type only.
// App provenance lives at status.performed_via_github_app.slug — never in
// creator.app_slug.
const VERCEL_CREATOR = { login: "vercel[bot]", type: "Bot" };
const HUMAN_CREATOR = { login: "alice", type: "User" };
const OTHER_USER_CREATOR = { login: "mallory", type: "User" };
const OTHER_APP_CREATOR = { login: "dependabot[bot]", type: "Bot" };

// Raw REST performed_via_github_app objects (extra fields kept for realism).
const VERCEL_APP_PROVENANCE = {
  id: 1296269,
  slug: "vercel",
  name: "Vercel",
  avatar_url: "https://avatars.githubusercontent.com/u/14985020?v=4",
};
const OTHER_APP_PROVENANCE = { id: 15368, slug: "dependabot", name: "dependabot" };

type Resolution = {
  state: string;
  reason?: string;
  verificationUrl?: string;
  monitoringUrl?: string;
};

/** Automatic generated-URL status, raw REST shape. */
function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://api.github.com/repos/o/r/deployments/41/statuses/10",
    id: 10,
    node_id: "SD_kwDOExample",
    state: "success",
    description: null,
    target_url: null,
    environment_url: VERIFICATION_URL,
    creator: { ...VERCEL_CREATOR },
    performed_via_github_app: { ...VERCEL_APP_PROVENANCE },
    created_at: "2026-09-25T12:00:00Z",
    updated_at: "2026-09-25T12:00:00Z",
    ...overrides,
  };
}

/** Manually verified stable status, raw REST shape. */
function manualStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return status({
    id: 100,
    description: MANUAL_STABLE_STATUS_MARKER,
    environment_url: MONITORING_URL,
    creator: { ...HUMAN_CREATOR },
    performed_via_github_app: null,
    ...overrides,
  });
}

function deployment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 41, sha: SHA, environment: "production", ...overrides };
}

function inputs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedDeploymentId: 41,
    expectedSha: SHA,
    expectedEnvironment: "production",
    deployment: deployment(),
    statuses: [],
    eventUrl: VERIFICATION_URL,
    ...overrides,
  };
}

function resolve(input: Record<string, unknown>): Resolution {
  return resolveUrlRoles(
    input as Parameters<typeof resolveUrlRoles>[0],
  ) as unknown as Resolution;
}

test("marker is exactly verify-fix:stable-alias-verified", () => {
  assert.equal(MANUAL_STABLE_STATUS_MARKER, "verify-fix:stable-alias-verified");
  assert.equal(VERCEL_APP_SLUG, "vercel");
});

test("raw REST provenance fields map to explicit internal names", () => {
  const mapped = mapStatusProvenance({
    id: 10,
    state: "success",
    description: null,
    environment_url: VERIFICATION_URL,
    creator: { login: "vercel[bot]", type: "Bot" },
    performed_via_github_app: { slug: "vercel", id: 1296269 },
  });
  assert.deepEqual(mapped, {
    ok: true,
    creatorLogin: "vercel[bot]",
    creatorType: "Bot",
    githubAppSlug: "vercel",
  });

  const noApp = mapStatusProvenance({
    id: 10,
    state: "success",
    description: null,
    environment_url: VERIFICATION_URL,
    creator: { login: "alice", type: "User" },
    performed_via_github_app: null,
  });
  assert.deepEqual(noApp, {
    ok: true,
    creatorLogin: "alice",
    creatorType: "User",
    githubAppSlug: null,
  });

  const absent = mapStatusProvenance({
    id: 10,
    state: "success",
    description: null,
    environment_url: null,
    creator: { login: "alice", type: "User" },
  });
  assert.deepEqual(absent, {
    ok: true,
    creatorLogin: "alice",
    creatorType: "User",
    githubAppSlug: null,
  });
});

test("origin rule accepts bare HTTPS origins and normalizes a trailing slash", () => {
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org"), MONITORING_URL);
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org/"), MONITORING_URL);
  assert.equal(normalizeHttpsOrigin(VERIFICATION_URL), VERIFICATION_URL);
});

test("origin rule rejects a non-root path", () => {
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org/slots"), null);
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org/app/"), null);
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org/index.html"), null);
});

test("origin rule rejects a query string", () => {
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org/?a=1"), null);
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org/?a=1&b=2"), null);
  assert.equal(normalizeHttpsOrigin(`${VERIFICATION_URL}?redirect=1`), null);
});

test("origin rule rejects a fragment", () => {
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org/#x"), null);
  assert.equal(normalizeHttpsOrigin(`${VERIFICATION_URL}#frag`), null);
});

test("origin rule rejects embedded credentials", () => {
  assert.equal(normalizeHttpsOrigin("https://user:pass@monitoring.example.org/"), null);
  assert.equal(normalizeHttpsOrigin("https://user@monitoring.example.org/"), null);
});

test("origin rule rejects control characters", () => {
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org/\u0007"), null);
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org\u0000"), null);
  assert.equal(normalizeHttpsOrigin("https://monitoring.example.org/\tx"), null);
});

test("origin rule rejects non-HTTPS and non-string values", () => {
  assert.equal(normalizeHttpsOrigin("http://monitoring.example.org/"), null);
  assert.equal(normalizeHttpsOrigin("ftp://monitoring.example.org/"), null);
  assert.equal(normalizeHttpsOrigin(null), null);
  assert.equal(normalizeHttpsOrigin(undefined), null);
  assert.equal(normalizeHttpsOrigin(42), null);
  assert.equal(normalizeHttpsOrigin(""), null);
  assert.equal(normalizeHttpsOrigin("not a url"), null);
});

test("preflight inputs: valid inputs pass", () => {
  assert.equal(validatePreflightInputs({
    deploymentId: 41,
    sha: SHA,
    environment: "production",
    eventUrl: VERIFICATION_URL,
  }), null);
});

test("preflight inputs: deployment id must be a positive safe integer first", () => {
  const base = { sha: SHA, environment: "production", eventUrl: VERIFICATION_URL };
  assert.equal(
    validatePreflightInputs({ ...base, deploymentId: 0 }),
    "expected-deployment-id-invalid",
  );
  assert.equal(
    validatePreflightInputs({ ...base, deploymentId: -3 }),
    "expected-deployment-id-invalid",
  );
  assert.equal(
    validatePreflightInputs({ ...base, deploymentId: 41.5 }),
    "expected-deployment-id-invalid",
  );
  assert.equal(
    validatePreflightInputs({ ...base, deploymentId: Number.NaN }),
    "expected-deployment-id-invalid",
  );
  assert.equal(
    validatePreflightInputs({ ...base, deploymentId: "41" }),
    "expected-deployment-id-invalid",
  );
  // id is checked before the other fields: bad id + bad sha yields the id reason.
  assert.equal(
    validatePreflightInputs({ deploymentId: 0, sha: "short", environment: "", eventUrl: "x" }),
    "expected-deployment-id-invalid",
  );
});

test("preflight inputs: sha must be exactly 40 hexadecimal characters", () => {
  const base = { deploymentId: 41, environment: "production", eventUrl: VERIFICATION_URL };
  assert.equal(
    validatePreflightInputs({ ...base, sha: "a".repeat(39) }),
    "expected-sha-invalid",
  );
  assert.equal(
    validatePreflightInputs({ ...base, sha: "a".repeat(41) }),
    "expected-sha-invalid",
  );
  assert.equal(
    validatePreflightInputs({ ...base, sha: "g".repeat(40) }),
    "expected-sha-invalid",
  );
  assert.equal(
    validatePreflightInputs({ ...base, sha: 42 }),
    "expected-sha-invalid",
  );
});

test("preflight inputs: environment and event URL are required", () => {
  const base = { deploymentId: 41, sha: SHA, eventUrl: VERIFICATION_URL };
  assert.equal(
    validatePreflightInputs({ ...base, environment: "" }),
    "expected-environment-invalid",
  );
  assert.equal(
    validatePreflightInputs({ ...base, environment: "Production", eventUrl: "nope" }),
    "unsafe-event-url",
  );
});

test("deployment record validation: shape before trust", () => {
  assert.equal(validateDeploymentRecord(deployment()), null);
  assert.equal(validateDeploymentRecord(null), "deployment-response-invalid");
  assert.equal(validateDeploymentRecord("nope"), "deployment-response-invalid");
  assert.equal(validateDeploymentRecord(deployment({ id: 41.5 })), "deployment-response-invalid");
  assert.equal(validateDeploymentRecord(deployment({ id: -1 })), "deployment-response-invalid");
  assert.equal(validateDeploymentRecord(deployment({ id: "41" })), "deployment-response-invalid");
  assert.equal(validateDeploymentRecord(deployment({ sha: 7 })), "deployment-response-invalid");
  assert.equal(
    validateDeploymentRecord(deployment({ environment: null })),
    "deployment-response-invalid",
  );
});

test("ready: raw-REST Vercel status + human marker status become the two roles", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ id: 10, environment_url: "https://deploy-slug.vercel.app/" }),
      manualStatus({ id: 100, environment_url: `${MONITORING_URL}/` }),
    ],
  }));
  assert.equal(resolution.state, "ready");
  assert.equal(resolution.reason, "complete-url-role-pair");
  assert.equal(resolution.verificationUrl, VERIFICATION_URL);
  assert.equal(resolution.monitoringUrl, MONITORING_URL);
});

test("ready: triggering event may target either role origin", () => {
  const statuses = [status({ id: 10 }), manualStatus({ id: 100 })];
  assert.equal(
    resolve(inputs({ statuses, eventUrl: VERIFICATION_URL })).state,
    "ready",
  );
  assert.equal(
    resolve(inputs({ statuses, eventUrl: `${MONITORING_URL}/` })).state,
    "ready",
  );
});

test("waiting: no statuses at all", () => {
  const resolution = resolve(inputs());
  assert.equal(resolution.state, "waiting");
  assert.equal(resolution.reason, "waiting-for-both-statuses");
});

test("waiting: only the generated role exists", () => {
  const resolution = resolve(inputs({ statuses: [status({ id: 10 })] }));
  assert.equal(resolution.state, "waiting");
  assert.equal(resolution.reason, "waiting-for-manual-stable-status");
});

test("waiting: only the manual marker role exists — it cannot impersonate the generated role", () => {
  const resolution = resolve(inputs({ statuses: [manualStatus({ id: 100 })] }));
  assert.equal(resolution.state, "waiting");
  assert.equal(resolution.reason, "waiting-for-generated-status");
});

test("waiting: unrelated statuses alone never become a role", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({
        id: 1,
        creator: { ...OTHER_USER_CREATOR },
        performed_via_github_app: null,
        description: "ci: someone",
      }),
      status({
        id: 2,
        creator: { ...OTHER_APP_CREATOR },
        performed_via_github_app: { ...OTHER_APP_PROVENANCE },
        description: "some unrelated check",
      }),
    ],
  }));
  assert.equal(resolution.state, "waiting");
  assert.equal(resolution.reason, "waiting-for-both-statuses");
});

test("unrelated successful statuses are ignored, never become the verification URL", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({
        id: 10,
        creator: { ...OTHER_USER_CREATOR },
        performed_via_github_app: null,
        environment_url: "https://evil.example.org",
      }),
      status({
        id: 11,
        creator: { ...OTHER_APP_CREATOR },
        performed_via_github_app: { ...OTHER_APP_PROVENANCE },
        environment_url: "https://bot.example.org",
      }),
      status({ id: 12, description: "mentions monitoring but not the marker" }),
      status({ id: 13 }),
      manualStatus({ id: 100 }),
    ],
  }));
  assert.equal(resolution.state, "ready");
  assert.equal(resolution.verificationUrl, VERIFICATION_URL);
  assert.equal(resolution.monitoringUrl, MONITORING_URL);
});

test("a human status without the marker cannot fill the generated role", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({
        id: 10,
        creator: { ...HUMAN_CREATOR },
        performed_via_github_app: null,
        environment_url: "https://user-chose-this.example.org",
      }),
      manualStatus({ id: 100 }),
    ],
  }));
  assert.equal(resolution.state, "waiting");
  assert.equal(resolution.reason, "waiting-for-generated-status");
});

test("missing performed_via_github_app is rejected as generated evidence", () => {
  const noAppField = status({ id: 10 });
  delete (noAppField as Record<string, unknown>).performed_via_github_app;
  const resolution = resolve(inputs({
    statuses: [noAppField, manualStatus({ id: 100 })],
  }));
  // Bot creator without raw app provenance can never be the generated role.
  assert.equal(resolution.state, "waiting");
  assert.equal(resolution.reason, "waiting-for-generated-status");
});

test("creator.app_slug is never read as provenance", () => {
  const spoof = status({ id: 10, creator: { login: "vercel[bot]", type: "Bot", app_slug: "vercel" } });
  delete (spoof as Record<string, unknown>).performed_via_github_app;
  const resolution = resolve(inputs({
    statuses: [spoof, manualStatus({ id: 100 })],
  }));
  assert.equal(resolution.state, "waiting");
  assert.equal(resolution.reason, "waiting-for-generated-status");
});

test("wrong app slug is ignored, never the generated role", () => {
  const wrongApp = status({
    id: 10,
    performed_via_github_app: { ...OTHER_APP_PROVENANCE },
  });
  const resolution = resolve(inputs({
    statuses: [wrongApp, manualStatus({ id: 100 })],
  }));
  assert.equal(resolution.state, "waiting");
  assert.equal(resolution.reason, "waiting-for-generated-status");
});

test("a Vercel App status carrying the manual marker is invalid", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ id: 10 }),
      manualStatus({ id: 100, creator: { ...VERCEL_CREATOR }, performed_via_github_app: { ...VERCEL_APP_PROVENANCE } }),
    ],
  }));
  assert.equal(resolution.state, "invalid");
  assert.equal(resolution.reason, "manual-creator-not-human");
});

test("a bot status carrying the marker is invalid, not a manual role", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ id: 10 }),
      manualStatus({ id: 100, creator: { ...OTHER_APP_CREATOR }, performed_via_github_app: { ...OTHER_APP_PROVENANCE } }),
    ],
  }));
  assert.equal(resolution.state, "invalid");
  assert.equal(resolution.reason, "manual-creator-not-human");
});

test("a human marker status with Vercel App provenance is invalid for the manual role", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ id: 10 }),
      manualStatus({ id: 100, performed_via_github_app: { ...VERCEL_APP_PROVENANCE } }),
    ],
  }));
  assert.equal(resolution.state, "invalid");
  assert.equal(resolution.reason, "manual-has-vercel-provenance");
});

test("a human marker status with ANY non-Vercel GitHub App provenance is invalid for the manual role", () => {
  for (const app of [
    { ...OTHER_APP_PROVENANCE },
    { id: 1, slug: "some-other-app", name: "Some Other App" },
  ]) {
    const resolution = resolve(inputs({
      statuses: [
        status({ id: 10 }),
        manualStatus({ id: 100, performed_via_github_app: app }),
      ],
    }));
    assert.equal(resolution.state, "invalid", JSON.stringify(app));
    assert.equal(resolution.reason, "manual-has-vercel-provenance", JSON.stringify(app));
  }
  // Absent AND null app provenance remain the only valid manual shapes.
  const absentFieldManual = manualStatus({ id: 100 });
  delete (absentFieldManual as Record<string, unknown>).performed_via_github_app;
  const undefinedFieldManual = manualStatus({ id: 100 });
  delete (undefinedFieldManual as Record<string, unknown>).performed_via_github_app;
  (undefinedFieldManual as Record<string, unknown>).performed_via_github_app = undefined;
  for (const manual of [
    manualStatus({ id: 100 }),
    manualStatus({ id: 100, performed_via_github_app: null }),
    absentFieldManual,
    undefinedFieldManual,
  ]) {
    const resolution = resolve(inputs({
      statuses: [status({ id: 10 }), manual],
    }));
    assert.equal(resolution.state, "ready", JSON.stringify(manual));
  }
});

test("history: older pending followed by newer success is ready", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ id: 1, state: "pending" }),
      status({ id: 2, state: "success" }),
      manualStatus({ id: 100 }),
    ],
  }));
  assert.equal(resolution.state, "ready");
});

test("history: older success followed by newer failure is invalid", () => {
  for (const state of ["pending", "failure", "inactive", "error"]) {
    const resolution = resolve(inputs({
      statuses: [
        status({ id: 1, state: "success" }),
        status({ id: 2, state }),
        manualStatus({ id: 100 }),
      ],
    }));
    assert.equal(resolution.state, "invalid", `newer state: ${state}`);
    assert.equal(resolution.reason, "generated-current-not-successful");
  }
});

test("history: older manual success followed by newer manual failure is invalid", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ id: 10 }),
      manualStatus({ id: 100, state: "success" }),
      manualStatus({ id: 101, state: "pending" }),
    ],
  }));
  assert.equal(resolution.state, "invalid");
  assert.equal(resolution.reason, "manual-current-not-successful");
});

test("history: repeated lifecycle statuses are fine; current is greatest id", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ id: 1, state: "success" }),
      status({ id: 2, state: "pending" }),
      status({ id: 3, state: "failure" }),
      status({ id: 4, state: "success" }),
      manualStatus({ id: 100, state: "success" }),
      manualStatus({ id: 101, state: "pending" }),
      manualStatus({ id: 102, state: "success" }),
    ],
  }));
  assert.equal(resolution.state, "ready");
});

test("history: list order is irrelevant — same rows reversed give the same result", () => {
  const rows = [
    status({ id: 1, state: "success" }),
    status({ id: 4, state: "success" }),
    status({ id: 2, state: "pending" }),
    manualStatus({ id: 100, state: "success" }),
    manualStatus({ id: 102, state: "success" }),
    manualStatus({ id: 101, state: "pending" }),
  ];
  const forward = resolve(inputs({ statuses: rows }));
  const reversed = resolve(inputs({ statuses: [...rows].reverse() }));
  assert.equal(forward.state, "ready");
  assert.equal(reversed.state, "ready");
  assert.equal(forward.verificationUrl, reversed.verificationUrl);
  assert.equal(forward.monitoringUrl, reversed.monitoringUrl);
});

test("history: duplicate id with conflicting data is invalid", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ id: 7, state: "success" }),
      status({ id: 7, state: "failure" }),
      manualStatus({ id: 100 }),
    ],
  }));
  assert.equal(resolution.state, "invalid");
  assert.equal(resolution.reason, "duplicate-status-id");
});

test("history: duplicate id across the two roles is invalid", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ id: 7 }),
      manualStatus({ id: 7 }),
    ],
  }));
  assert.equal(resolution.state, "invalid");
  assert.equal(resolution.reason, "duplicate-status-id");
});

test("history: unrelated statuses mixed with both roles do not disturb selection", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ id: 200, creator: { ...OTHER_USER_CREATOR }, performed_via_github_app: null, description: "unrelated success" }),
      status({ id: 3, state: "pending" }),
      status({ id: 4, state: "success" }),
      manualStatus({ id: 101, state: "pending" }),
      manualStatus({ id: 102, state: "success" }),
      status({ id: 500, creator: { ...OTHER_APP_CREATOR }, performed_via_github_app: { ...OTHER_APP_PROVENANCE }, state: "failure" }),
    ],
  }));
  assert.equal(resolution.state, "ready");
  assert.equal(resolution.verificationUrl, VERIFICATION_URL);
  assert.equal(resolution.monitoringUrl, MONITORING_URL);
});

test("untrusted raw entries: null, arrays, and primitives fail closed without throwing", () => {
  const badRows: unknown[] = [null, ["array-row"], "string-row", 42, true];
  for (const row of badRows) {
    const resolution = resolve(inputs({ statuses: [row] }));
    assert.equal(resolution.state, "invalid", JSON.stringify(row));
    assert.equal(resolution.reason, "status-record-invalid", JSON.stringify(row));
  }
  // Non-array statuses payload.
  assert.equal(resolve(inputs({ statuses: "nope" })).reason, "statuses-response-invalid");
  assert.equal(resolve(inputs({ statuses: {} })).reason, "statuses-response-invalid");
});

test("untrusted raw entries: missing or malformed creator fails closed", () => {
  const creators: unknown[] = [
    null,
    undefined,
    "vercel",
    42,
    [],
    {},
    { login: "alice" },
    { type: "Bot" },
    { login: "", type: "Bot" },
    { login: "x", type: "" },
    { login: 7, type: "Bot" },
    { login: "x", type: 42 },
  ];
  for (const creator of creators) {
    const resolution = resolve(inputs({
      statuses: [status({ id: 10, creator })],
    }));
    assert.equal(resolution.state, "invalid", JSON.stringify(creator));
    assert.equal(resolution.reason, "status-creator-invalid", JSON.stringify(creator));
    const mapped = mapStatusProvenance({ id: 1, state: "success", creator });
    assert.equal(mapped.ok, false, JSON.stringify(creator));
    if (!mapped.ok) assert.equal(mapped.reason, "status-creator-invalid");
  }
});

test("untrusted raw entries: malformed app metadata fails closed, absent/null is allowed", () => {
  const badApps: unknown[] = ["vercel", 42, true, [], {}, { id: 1 }, { slug: null }, { slug: "" }, { slug: 123 }];
  for (const app of badApps) {
    const resolution = resolve(inputs({
      statuses: [status({ id: 10, performed_via_github_app: app })],
    }));
    assert.equal(resolution.state, "invalid", JSON.stringify(app));
    assert.equal(resolution.reason, "status-app-provenance-invalid", JSON.stringify(app));
  }
  // Absent or null app provenance validates cleanly (mapping only).
  assert.equal(mapStatusProvenance({ id: 1, state: "s", creator: { login: "a", type: "User" } }).ok, true);
  assert.equal(
    mapStatusProvenance({
      id: 1,
      state: "s",
      creator: { login: "a", type: "User" },
      performed_via_github_app: null,
    }).ok,
    true,
  );
});

test("untrusted raw entries: invalid ids and states fail closed on every row", () => {
  for (const id of ["10", -5, 0, 1.5, null, undefined]) {
    const resolution = resolve(inputs({
      statuses: [status({ id })],
    }));
    assert.equal(resolution.state, "invalid", String(id));
    assert.equal(resolution.reason, "status-id-invalid", String(id));
  }
  for (const state of ["", 42, null, undefined]) {
    const resolution = resolve(inputs({
      statuses: [status({ id: 10, state })],
    }));
    assert.equal(resolution.state, "invalid", String(state));
    assert.equal(resolution.reason, "status-state-invalid", String(state));
  }
  // Even rows that are ignored as unrelated publishers must be well-formed.
  const unrelatedBadId = status({
    id: "not-a-number",
    creator: { ...OTHER_USER_CREATOR },
    performed_via_github_app: null,
  });
  assert.equal(resolve(inputs({ statuses: [unrelatedBadId] })).reason, "status-id-invalid");
  const unrelatedBadState = status({
    id: 5,
    state: null,
    creator: { ...OTHER_USER_CREATOR },
    performed_via_github_app: null,
  });
  assert.equal(resolve(inputs({ statuses: [unrelatedBadState] })).reason, "status-state-invalid");
});

test("status state outside the exact GitHub enum fails closed on every row", () => {
  const outsideEnum = [
    "",
    "SUCCESS",
    "Success",
    "succeeded",
    "waiting",
    "ok",
    "in-progress",
    "in progress",
    "running",
    "cancelled",
    "partial_success",
  ];
  for (const state of outsideEnum) {
    const resolution = resolve(inputs({ statuses: [status({ id: 10, state })] }));
    assert.equal(resolution.state, "invalid", state);
    assert.equal(resolution.reason, "status-state-invalid", state);
  }
  // Even an unrelated publisher's row must carry an exact-enum state.
  for (const state of outsideEnum) {
    const unrelated = status({
      id: 5,
      state,
      creator: { ...OTHER_USER_CREATOR },
      performed_via_github_app: null,
    });
    assert.equal(
      resolve(inputs({ statuses: [unrelated] })).reason,
      "status-state-invalid",
      `unrelated row state: ${state}`,
    );
  }
});

test("every exact GitHub state value passes validation and only success can reach ready", () => {
  const exactEnum = ["error", "failure", "inactive", "in_progress", "queued", "pending", "success"];
  for (const state of exactEnum) {
    // Unrelated row with this state: fully validated, then ignored.
    const unrelated = status({
      id: 1,
      state,
      creator: { ...OTHER_USER_CREATOR },
      performed_via_github_app: null,
      description: "unrelated",
    });
    const ignored = resolve(inputs({ statuses: [unrelated] }));
    assert.equal(ignored.state, "waiting", state);
    assert.equal(ignored.reason, "waiting-for-both-statuses", state);
    // Role row with this state: validated as the current generated status —
    // never rejected as a bad state; non-success currents fail as such.
    const pair = resolve(inputs({
      statuses: [status({ id: 10, state }), manualStatus({ id: 100 })],
    }));
    if (state === "success") {
      assert.equal(pair.state, "ready", state);
      assert.equal(pair.reason, "complete-url-role-pair", state);
    } else {
      assert.equal(pair.state, "invalid", state);
      assert.equal(pair.reason, "generated-current-not-successful", state);
    }
  }
});

test("untrusted raw entries: malformed description and environment_url fail closed", () => {
  assert.equal(
    resolve(inputs({ statuses: [status({ id: 10, description: 7 }), manualStatus()] })).reason,
    "status-description-invalid",
  );
  assert.equal(
    resolve(inputs({ statuses: [status({ id: 10 }), manualStatus({ description: {} })] })).reason,
    "status-description-invalid",
  );
  assert.equal(
    resolve(inputs({ statuses: [status({ id: 10, environment_url: 7 }), manualStatus()] })).reason,
    "status-environment-url-invalid",
  );
  assert.equal(
    resolve(inputs({ statuses: [status(), manualStatus({ state: null })] })).reason,
    "status-state-invalid",
  );
  assert.equal(resolve(inputs({ statuses: [null] })).reason, "status-record-invalid");
});

test("deployment not found / mismatch fail closed", () => {
  assert.equal(resolve(inputs({ deployment: null })).reason, "deployment-not-found");
  assert.equal(
    resolve(inputs({ deployment: deployment({ id: 42 }) })).reason,
    "deployment-id-mismatch",
  );
  assert.equal(
    resolve(inputs({ deployment: deployment({ sha: "b".repeat(40) }) })).reason,
    "deployment-sha-mismatch",
  );
  assert.equal(
    resolve(inputs({ deployment: deployment({ environment: "preview" }) })).reason,
    "deployment-environment-mismatch",
  );
  assert.equal(
    resolve(inputs({ deployment: deployment({ id: 41.2 }) })).reason,
    "deployment-response-invalid",
  );
  assert.equal(
    resolve(inputs({ expectedDeploymentId: 42 })).reason,
    "deployment-id-mismatch",
  );
});

test("unsafe role URLs fail closed for each origin-rule violation", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["non-root path", { environment_url: "https://deploy-slug.vercel.app/app" }],
    ["query", { environment_url: "https://deploy-slug.vercel.app/?x=1" }],
    ["fragment", { environment_url: "https://deploy-slug.vercel.app/#x" }],
    ["credentials", { environment_url: "https://u@deploy-slug.vercel.app/" }],
    ["non-HTTPS", { environment_url: "http://deploy-slug.vercel.app" }],
    ["control character", { environment_url: "https://deploy-slug.vercel.app/\u0001" }],
    ["missing", { environment_url: null }],
  ];
  for (const [label, overrides] of cases) {
    const resolution = resolve(inputs({
      statuses: [status(overrides), manualStatus()],
    }));
    assert.equal(resolution.state, "invalid", label);
    assert.equal(resolution.reason, "unsafe-verification-url", label);
  }

  const manualCases: Array<[string, Record<string, unknown>]> = [
    ["non-root path", { environment_url: "https://monitoring.example.org/slots" }],
    ["query", { environment_url: "https://monitoring.example.org/?x=1" }],
    ["fragment", { environment_url: "https://monitoring.example.org/#x" }],
    ["credentials", { environment_url: "https://u:pw@monitoring.example.org/" }],
    ["non-HTTPS", { environment_url: "http://monitoring.example.org" }],
  ];
  for (const [label, overrides] of manualCases) {
    const resolution = resolve(inputs({
      statuses: [status(), manualStatus(overrides)],
    }));
    assert.equal(resolution.state, "invalid", label);
    assert.equal(resolution.reason, "unsafe-monitoring-url", label);
  }
});

test("overlapping URL roles are invalid even when written with a trailing slash", () => {
  const resolution = resolve(inputs({
    statuses: [
      status({ environment_url: "https://same.example.org" }),
      manualStatus({ environment_url: "https://same.example.org/" }),
    ],
  }));
  assert.equal(resolution.state, "invalid");
  assert.equal(resolution.reason, "overlapping-url-roles");
});

test("event URL must satisfy the same origin rule", () => {
  const statuses = [status(), manualStatus()];
  assert.equal(
    resolve(inputs({ statuses, eventUrl: "https://monitoring.example.org/slots" })).reason,
    "unsafe-event-url",
  );
  assert.equal(
    resolve(inputs({ statuses, eventUrl: "" })).reason,
    "unsafe-event-url",
  );
  assert.equal(
    resolve(inputs({ statuses, eventUrl: "ftp://monitoring.example.org/" })).reason,
    "unsafe-event-url",
  );
});

test("event URL must match one of the two role origins", () => {
  const statuses = [status(), manualStatus()];
  const resolution = resolve(inputs({
    statuses,
    eventUrl: "https://something-else.example.org",
  }));
  assert.equal(resolution.state, "invalid");
  assert.equal(resolution.reason, "event-url-mismatch");
});
