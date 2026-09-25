// @ts-check
// URL-role resolver for the secret-free production preflight (Stage 2).
//
// Two URL roles exist for one GitHub deployment of the current main revision,
// and BOTH are environment origins (no path, query, or fragment):
//   - verification origin: from the automatic deployment status published by
//     the trusted Vercel GitHub App on the SAME deployment. Used only as the
//     verification target.
//   - monitoring origin: from the manually verified stable alias the account
//     owner registers as one deployment status on the SAME deployment. Used
//     only as the monitoring target passed to `checkly deploy`.
//
// Raw GitHub REST provenance fields (deployment-status objects) and their
// explicit mapping to internal names:
//   - status.creator.login        -> creatorLogin (string, non-empty)
//   - status.creator.type         -> creatorType  (string, non-empty)
//   - status.performed_via_github_app
//         .slug                  -> githubAppSlug (string, non-empty, or
//                                    null when the field is absent/null)
// `creator.app_slug` is NOT a raw REST field and is never read here.
//
// Provenance rules (exact; nothing is identified from a guessed hostname):
//   - Generated role (automatic): creatorType === "Bot",
//     githubAppSlug === "vercel", a non-empty creatorLogin, no manual marker,
//     and a valid status id/state/origin on the same deployment.
//   - Manual role: description === MANUAL_STABLE_STATUS_MARKER (exact),
//     creatorType === "User", non-empty creatorLogin, and
//     performed_via_github_app ABSENT or null. ANY GitHub App provenance —
//     Vercel or any other app — makes a marker status invalid (spoofing
//     evidence, not a role), as does a non-User creator. A human marker
//     status can never satisfy the generated role because it lacks Vercel
//     provenance.
//   - The manual status must be created with auto_inactive: false so posting
//     it does not inactivate the automatic success status.
//   - Statuses from any other publisher (unrelated users, bots, apps, or
//     free-text descriptions) are ignored entirely — they can never become
//     either role.
//   - Malformed raw entries (null/array/primitive rows, missing or malformed
//     creator, malformed app metadata, invalid ids, states outside GitHub's
//     exact enum, invalid descriptions/URLs) fail closed with a stable
//     reason and never throw.
//
// Status history: GitHub returns the full status history, not one record.
// Within each authenticated role, the current status is the one with the
// GREATEST validated numeric status id (immutable GitHub ordering). The
// current status of each role must be "success"; an older success is never
// accepted over a newer pending/failed/inactive/errored status. Duplicate
// status ids or contradictory records are invalid. Input order is irrelevant.
//
// Nothing here calls Vercel, reads a token, or follows a redirect. Inputs are
// GitHub deployment metadata and statuses only, so the caller stays
// secret-free, VERCEL_TOKEN-free, and provider-neutral.

/**
 * The one exact marker that identifies a manually verified stable status.
 * @type {string}
 */
export const MANUAL_STABLE_STATUS_MARKER = "verify-fix:stable-alias-verified";

/** The GitHub App slug of the trusted Vercel GitHub App. */
export const VERCEL_APP_SLUG = "vercel";

/**
 * GitHub's exact deployment-status `state` enum. A status whose state is any
 * other string (or a non-string) fails closed as `status-state-invalid`.
 * @type {ReadonlySet<string>}
 */
const GITHUB_STATUS_STATES = new Set([
  "error",
  "failure",
  "inactive",
  "in_progress",
  "queued",
  "pending",
  "success",
]);

/**
 * @typedef {object} DeploymentStatusEvidence
 * @property {number} id
 * @property {string} state
 * @property {string | null} description
 * @property {string | null} environment_url
 * @property {{ login: string, type: string }} creator
 * @property {{ slug: string } | null} [performed_via_github_app]
 */

/**
 * @typedef {object} DeploymentEvidence
 * @property {number} id
 * @property {string} sha
 * @property {string} environment
 */

/**
 * @typedef {object} UrlRoleInputs
 * @property {number} expectedDeploymentId
 * @property {string} expectedSha
 * @property {string} expectedEnvironment
 * @property {DeploymentEvidence | null} deployment
 * @property {unknown[]} statuses
 * @property {string} eventUrl
 */

/**
 * @typedef {{ state: "waiting", reason: string }
 *   | { state: "ready", reason: string, verificationUrl: string, monitoringUrl: string }
 *   | { state: "invalid", reason: string }} UrlRoleResolution
 */

/**
 * Explicit raw-REST provenance mapping plus its validation outcome.
 * @typedef {{ ok: true, creatorLogin: string, creatorType: string,
 *   githubAppSlug: string | null }
 *   | { ok: false, reason: string }} StatusProvenance
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * A role value must be a bare HTTPS origin: scheme https, a hostname, no
 * username or password, no path other than "/" (a permitted trailing slash
 * normalizes away), no query, no fragment, and no control characters.
 * Returns the normalized `URL.origin`, or null when the value is not a
 * permitted origin.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeHttpsOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (CONTROL_CHARACTERS.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.hostname === "") return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (parsed.search !== "") return null;
  if (parsed.hash !== "") return null;
  return parsed.origin;
}

/**
 * Map one raw deployment-status row's creator/app provenance fields onto the
 * explicit internal names (`creatorLogin`, `creatorType`, `githubAppSlug`) and
 * validate them. `creator.app_slug` is deliberately not read: the raw REST
 * field for app provenance is `performed_via_github_app.slug` (absent/null
 * means no GitHub App performed the action).
 *
 * @param {unknown} row
 * @returns {StatusProvenance}
 */
export function mapStatusProvenance(row) {
  if (!isPlainObject(row)) return { ok: false, reason: "status-record-invalid" };
  const creator = row.creator;
  if (!isPlainObject(creator)) return { ok: false, reason: "status-creator-invalid" };
  const login = creator.login;
  const type = creator.type;
  if (typeof login !== "string" || login.length === 0) {
    return { ok: false, reason: "status-creator-invalid" };
  }
  if (typeof type !== "string" || type.length === 0) {
    return { ok: false, reason: "status-creator-invalid" };
  }
  // performed_via_github_app: absent or null means "no GitHub App".
  const app = row.performed_via_github_app === undefined
    ? null
    : row.performed_via_github_app;
  let githubAppSlug = null;
  if (app !== null) {
    if (!isPlainObject(app)) return { ok: false, reason: "status-app-provenance-invalid" };
    if (typeof app.slug !== "string" || app.slug.length === 0) {
      return { ok: false, reason: "status-app-provenance-invalid" };
    }
    githubAppSlug = app.slug;
  }
  return { ok: true, creatorLogin: login, creatorType: type, githubAppSlug };
}

/**
 * Validate the untrusted preflight inputs BEFORE any API path is built.
 * Returns null when valid, or a stable failure reason.
 *
 * @param {{ deploymentId: unknown, sha: unknown, environment: unknown, eventUrl: unknown }} input
 * @returns {string | null}
 */
export function validatePreflightInputs(input) {
  if (typeof input.deploymentId !== "number" || !Number.isSafeInteger(input.deploymentId) ||
    input.deploymentId <= 0) {
    return "expected-deployment-id-invalid";
  }
  if (typeof input.sha !== "string" || !/^[0-9a-fA-F]{40}$/.test(input.sha)) {
    return "expected-sha-invalid";
  }
  if (typeof input.environment !== "string" || input.environment.length === 0) {
    return "expected-environment-invalid";
  }
  if (normalizeHttpsOrigin(input.eventUrl) === null) return "unsafe-event-url";
  return null;
}

/**
 * Validate the deployment response shape before it is trusted.
 * Returns null when valid, or a stable failure reason.
 *
 * @param {unknown} record
 * @returns {string | null}
 */
export function validateDeploymentRecord(record) {
  if (!isPlainObject(record)) return "deployment-response-invalid";
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id <= 0) {
    return "deployment-response-invalid";
  }
  if (typeof record.sha !== "string" || typeof record.environment !== "string") {
    return "deployment-response-invalid";
  }
  return null;
}

/** @param {string} reason @returns {UrlRoleResolution} */
function invalid(reason) {
  return { state: "invalid", reason };
}

/** @param {string} reason @returns {UrlRoleResolution} */
function waiting(reason) {
  return { state: "waiting", reason };
}

/**
 * Greatest validated id = the current status of one authenticated role.
 * @param {DeploymentStatusEvidence[]} rows
 * @returns {DeploymentStatusEvidence}
 */
function currentOf(rows) {
  let current = rows[0];
  for (const row of rows) {
    if (row.id > current.id) current = row;
  }
  return current;
}

/**
 * Decide the URL-role state for one deployment.
 *
 * - waiting: exactly one authenticated role has no status at all (generated
 *   absent, manual absent, or both). Not ready yet; must not request
 *   protected approval. A later event that adds the missing role may become
 *   ready.
 * - ready: both roles authenticated, each role's CURRENT status (greatest
 *   validated id) is "success", both origins safe and distinct, and the
 *   triggering event's normalized origin belongs to the pair.
 * - invalid: malformed, conflicting, ambiguous, duplicate-id, spoofed,
 *   wrong-deployment, wrong-SHA, or unsafe evidence. Fails closed.
 *
 * Status input order is irrelevant; selection is by immutable numeric id
 * within one authenticated role, never "latest across publishers".
 *
 * @param {UrlRoleInputs} input
 * @returns {UrlRoleResolution}
 */
export function resolveUrlRoles(input) {
  if (input.deployment === null || input.deployment === undefined) {
    return invalid("deployment-not-found");
  }
  const deploymentCheck = validateDeploymentRecord(input.deployment);
  if (deploymentCheck !== null) return invalid(deploymentCheck);
  if (Number(input.deployment.id) !== Number(input.expectedDeploymentId)) {
    return invalid("deployment-id-mismatch");
  }
  if (input.deployment.sha !== input.expectedSha) return invalid("deployment-sha-mismatch");
  if (input.deployment.environment !== input.expectedEnvironment) {
    return invalid("deployment-environment-mismatch");
  }
  if (!Array.isArray(input.statuses)) return invalid("statuses-response-invalid");

  /** @type {DeploymentStatusEvidence[]} */
  const generatedRows = [];
  /** @type {DeploymentStatusEvidence[]} */
  const manualRows = [];
  /** @type {Map<number, DeploymentStatusEvidence>} */
  const participatingIds = new Map();

  for (const row of input.statuses) {
    // Validate every raw entry before classification; never throw.
    if (!isPlainObject(row)) return invalid("status-record-invalid");
    const provenance = mapStatusProvenance(row);
    if (!provenance.ok) return invalid(provenance.reason);
    const { creatorLogin: _login, creatorType, githubAppSlug } = provenance;
    if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0) {
      return invalid("status-id-invalid");
    }
    if (typeof row.state !== "string" || !GITHUB_STATUS_STATES.has(row.state)) {
      return invalid("status-state-invalid");
    }
    if (row.description !== null && typeof row.description !== "string") {
      return invalid("status-description-invalid");
    }
    if (row.environment_url !== null && typeof row.environment_url !== "string") {
      return invalid("status-environment-url-invalid");
    }

    const isMarkerDescription = row.description === MANUAL_STABLE_STATUS_MARKER;
    const generatedProvenance = creatorType === "Bot" && githubAppSlug === VERCEL_APP_SLUG;
    // Unrelated publishers are ignored entirely: neither role, no id checks.
    if (!isMarkerDescription && !generatedProvenance) continue;

    if (participatingIds.has(row.id)) return invalid("duplicate-status-id");
    const evidence = /** @type {DeploymentStatusEvidence} */ (row);
    participatingIds.set(row.id, evidence);

    if (isMarkerDescription) {
      // Manual role: exact marker + human creator + NO GitHub App provenance
      // at all (`performed_via_github_app` must be absent or null). Any app
      // — Vercel or otherwise — invalidates the marker status.
      if (creatorType !== "User") return invalid("manual-creator-not-human");
      if (githubAppSlug !== null) return invalid("manual-has-vercel-provenance");
      manualRows.push(evidence);
    } else {
      // Generated role: provenance already proven above (Bot + vercel app).
      generatedRows.push(evidence);
    }
  }

  if (generatedRows.length === 0 && manualRows.length === 0) {
    return waiting("waiting-for-both-statuses");
  }
  if (generatedRows.length === 0) return waiting("waiting-for-generated-status");
  if (manualRows.length === 0) return waiting("waiting-for-manual-stable-status");

  const generatedCurrent = currentOf(generatedRows);
  if (generatedCurrent.state !== "success") {
    return invalid("generated-current-not-successful");
  }
  const manualCurrent = currentOf(manualRows);
  if (manualCurrent.state !== "success") {
    return invalid("manual-current-not-successful");
  }

  const verificationUrl = normalizeHttpsOrigin(generatedCurrent.environment_url);
  if (verificationUrl === null) return invalid("unsafe-verification-url");
  const monitoringUrl = normalizeHttpsOrigin(manualCurrent.environment_url);
  if (monitoringUrl === null) return invalid("unsafe-monitoring-url");
  if (verificationUrl === monitoringUrl) return invalid("overlapping-url-roles");

  const eventOrigin = normalizeHttpsOrigin(input.eventUrl);
  if (eventOrigin === null) return invalid("unsafe-event-url");
  if (eventOrigin !== verificationUrl && eventOrigin !== monitoringUrl) {
    return invalid("event-url-mismatch");
  }

  return {
    state: "ready",
    reason: "complete-url-role-pair",
    verificationUrl,
    monitoringUrl,
  };
}
