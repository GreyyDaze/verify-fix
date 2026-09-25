// @ts-check
// Secret-free production URL preflight (Stage 2).
//
// Pure dependency-free ESM (`.mjs`): executed directly by the existing
// setup-node runtime with no TypeScript stripping, no experimental flags,
// and no `.ts` workflow entrypoints. Only `GH_TOKEN`, `GITHUB_REPOSITORY`,
// and the workflow's event inputs are read — no Vercel API, no
// VERCEL_TOKEN, no cloud call, no response body or Authorization value is
// ever logged. Inputs are validated (positive safe-integer deployment id,
// 40-hex SHA, environment string) BEFORE any API path is built; deployment
// id is re-validated from the response before the statuses path is built.
//
// Pagination safety: status history is fetched through full bounded pages
// (fixed MAX_STATUS_PAGES/MAX_STATUSES) or the GitHub `Link` header. A
// `next` URL is forwarded only when it is https, on host api.github.com,
// carries no credentials, and matches the exact expected
// /repos/{repo}/deployments/{id}/statuses path — the Authorization header is
// never sent to an arbitrary URL copied from a `Link` header. Truncated or
// endless histories fail closed (`statuses-truncated`) — completeness is
// never inferred from a length of 100. Malformed evidence fails closed with
// a stable reason; response bodies and tokens are never logged. GITHUB_OUTPUT
// writes are single-line `name=value` pairs with strict identifier names —
// CR or LF in a name or value is rejected. Unexpected exceptions are
// reported only as the stable `runner-failed` reason; exception details are
// never printed because a message may embed a URL, response detail, or
// other sensitive value.
//
// Evidence contract (GITHUB_OUTPUT + process exit code):
//   - invalid evidence: `ready=false` and the stable reason are written to
//     GITHUB_OUTPUT, NO URL output is written, and the process exits
//     non-zero;
//   - waiting evidence: `ready=false` and the stable reason are written,
//     NO URL output, exit 0 (the caller's ready=='true' gate keeps waiting
//     out of approval);
//   - ready evidence: `ready=true`, the reason, and both role URLs are
//     written, exit 0.

import { appendFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  resolveUrlRoles,
  validatePreflightInputs,
} from "./deployment-url-roles.mjs";

/** Stable reasons this runner can add (resolver reasons pass through). */
// expected-deployment-id-invalid | expected-sha-invalid |
// expected-environment-invalid | unsafe-event-url | repository-invalid |
// github-token-missing | deployment-response-invalid | deployment-not-found |
// statuses-not-readable | statuses-response-invalid | statuses-link-invalid |
// statuses-truncated | runner-failed

const GITHUB_API_ORIGIN = "https://api.github.com";
/** Upper bound on status-history pages (full pages of 100 only). */
const MAX_STATUS_PAGES = 5;
/** Upper bound on collected statuses (pages × per_page). */
const MAX_STATUSES = 500;
/** Upper bound per page so a page cannot balloon the collection. */
const STATUS_PAGE_SIZE = 100;

/**
 * Validate the next-page URL from a GitHub `Link` header before any request
 * carries credentials. Accepts only https, host api.github.com, no
 * username/password, and the exact expected statuses path for this
 * repo/deployment. Returns the URL to fetch, or null when it must not be
 * followed.
 *
 * @param {string | null} nextUrlCandidate Raw URL from the Link header.
 * @param {string} repo Validated `owner/name`.
 * @param {number} deploymentId Validated positive safe integer.
 * @returns {string | null}
 */
export function resolveStatusesNextUrl(nextUrlCandidate, repo, deploymentId) {
  if (typeof nextUrlCandidate !== "string" || nextUrlCandidate.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(nextUrlCandidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.origin !== GITHUB_API_ORIGIN) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const expectedPath = `/repos/${repo}/deployments/${deploymentId}/statuses`;
  if (parsed.pathname !== expectedPath) return null;
  return parsed.href;
}

/**
 * Extract the `rel="next"` URL from a Link header, or null when absent.
 *
 * @param {string | null} linkHeader
 * @returns {string | null}
 */
function nextLinkFrom(linkHeader) {
  if (linkHeader === null) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (match === null) return null;
  return match[1] ?? null;
}

/**
 * One GET to an absolute github-api URL with the Authorization header.
 * Only https://api.github.com with no credentials receives the token, and
 * only the expected API paths are ever requested. Logs at most HTTP status —
 * never headers, bodies, tokens, or bypass values.
 *
 * @param {string} url
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, status: number,
 *   headers: { get(name: string): string | null },
 *   json(): Promise<unknown> }>}
 */
async function githubGet(url, token, fetchImpl = fetch) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 0, headers: { get: () => null }, json: async () => null };
  }
  if (parsed.protocol !== "https:" || parsed.origin !== GITHUB_API_ORIGIN ||
    parsed.username !== "" || parsed.password !== "") {
    return { ok: false, status: 0, headers: { get: () => null }, json: async () => null };
  }
  const response = await fetchImpl(parsed.href, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
    },
  });
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    json: () => response.json(),
  };
}

/**
 * Fetch the FULL status history for one deployment: full bounded pages or
 * the GitHub `Link` header. Never assumes "100 records = complete", never
 * follows a link off api.github.com, and never exceeds the fixed bounds.
 *
 * @param {string} repo `owner/name`
 * @param {number} deploymentId Validated positive safe integer.
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ statuses: unknown[] } | { error: string }>}
 */
export async function fetchAllStatuses(repo, deploymentId, token, fetchImpl = fetch) {
  let nextUrl =
    `${GITHUB_API_ORIGIN}/repos/${repo}/deployments/${deploymentId}/statuses?per_page=${STATUS_PAGE_SIZE}`;
  /** @type {unknown[]} */
  const collected = [];
  for (let page = 1; page <= MAX_STATUS_PAGES; page += 1) {
    const response = await githubGet(nextUrl, token, fetchImpl);
    if (!response.ok) {
      console.error(`[preflight] status page ${page} HTTP ${response.status}`);
      return { error: "statuses-not-readable" };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return { error: "statuses-response-invalid" };
    }
    if (!Array.isArray(body)) return { error: "statuses-response-invalid" };
    collected.push(...body);
    if (collected.length > MAX_STATUSES) return { error: "statuses-truncated" };

    const linkHeader = response.headers.get("link");
    const hasNext = linkHeader !== null && /rel="next"/.test(linkHeader);
    if (!hasNext) return { statuses: collected };
    const candidate = nextLinkFrom(linkHeader);
    const nextUrl2 = resolveStatusesNextUrl(candidate, repo, deploymentId);
    if (nextUrl2 === null) {
      // Malicious, off-host, wrong-path, or credentialed link: fail closed
      // and never forward the token there.
      return { error: "statuses-link-invalid" };
    }
    nextUrl = nextUrl2;
  }
  // A Link header kept pointing past the fixed bound: fail closed, never guess.
  return { error: "statuses-truncated" };
}

/**
 * Validate the deployment response shape (positive safe integer id) before
 * the id is used in any subsequent API path.
 *
 * @param {unknown} record
 * @returns {string | null}
 */
function validateDeploymentResponse(record) {
  if (typeof record !== "object" || record === null) return "deployment-response-invalid";
  const candidate = /** @type {{ id?: unknown, sha?: unknown, environment?: unknown }} */ (record);
  if (typeof candidate.id !== "number" || !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0) {
    return "deployment-response-invalid";
  }
  if (typeof candidate.sha !== "string" || typeof candidate.environment !== "string") {
    return "deployment-response-invalid";
  }
  return null;
}

/**
 * Record INVALID evidence: the stable reason on stdout plus `ready=false`
 * and the reason in GITHUB_OUTPUT. Never writes a URL output. The caller
 * exits non-zero after fail() returns.
 * @param {string} reason
 */
function fail(reason) {
  console.error(`[preflight] failed: ${reason}`);
  console.log(`ready=false`);
  console.log(`reason=${reason}`);
  writeOutput("ready", "false");
  writeOutput("reason", reason);
}

/** Strict safe identifier for GITHUB_OUTPUT names. */
const OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Write one preflight output line (`name=value`). Names must be strict safe
 * identifiers, and neither names nor values may contain CR or LF — only the
 * single-line GitHub output form is used, never multiline syntax. Any
 * violation throws (fail-closed injection rejection).
 *
 * @param {string} name
 * @param {string} value
 */
export function writeOutput(name, value) {
  if (typeof name !== "string" || !OUTPUT_NAME_PATTERN.test(name)) {
    throw new Error("invalid GITHUB_OUTPUT name");
  }
  if (typeof value !== "string" || value.includes("\n") || value.includes("\r")) {
    throw new Error("invalid GITHUB_OUTPUT value");
  }
  const file = process.env.GITHUB_OUTPUT;
  if (file !== undefined && file !== "") {
    appendFileSync(file, `${name}=${value}\n`, "utf8");
  }
}

/**
 * Entry point; only runs when executed as a script, never on import.
 * Unexpected exceptions never leak their details: only the stable
 * `runner-failed` evidence is printed and written.
 *
 * @returns {Promise<number>} Process exit code: 0 for ready and waiting
 *   evidence, non-zero for invalid evidence or failure.
 */
export async function main() {
  try {
    return await runPreflight();
  } catch {
    // Never print the exception message — it may embed a URL, response
    // detail, or other sensitive value. Stable reason only.
    fail("runner-failed");
    return 1;
  }
}

/**
 * The preflight itself; unexpected exceptions propagate to `main()`.
 * @returns {Promise<number>} Process exit code.
 */
async function runPreflight() {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GH_TOKEN ?? "";

  // Validate untrusted inputs BEFORE any API path is built.
  const deploymentId = process.env.DEPLOYMENT_ID === undefined
    ? Number.NaN
    : Number(process.env.DEPLOYMENT_ID);
  const inputReason = validatePreflightInputs({
    deploymentId,
    sha: process.env.DEPLOYMENT_SHA ?? "",
    environment: process.env.DEPLOYMENT_ENVIRONMENT ?? "",
    eventUrl: process.env.EVENT_URL ?? "",
  });
  if (inputReason !== null) {
    fail(inputReason);
    return 1;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    fail("repository-invalid");
    return 1;
  }
  if (token === "") {
    fail("github-token-missing");
    return 1;
  }

  // Deployment metadata only — no Vercel API, no VERCEL_TOKEN.
  const deploymentUrl =
    `${GITHUB_API_ORIGIN}/repos/${repo}/deployments/${deploymentId}`;
  const deploymentResponse = await githubGet(deploymentUrl, token);
  if (deploymentResponse.status === 404) {
    fail("deployment-not-found");
    return 1;
  }
  if (!deploymentResponse.ok) {
    fail("deployment-response-invalid");
    return 1;
  }
  let deployment;
  try {
    deployment = await deploymentResponse.json();
  } catch {
    fail("deployment-response-invalid");
    return 1;
  }
  // Re-validate the response (positive safe integer id) before it is used in
  // the statuses API path.
  const deploymentCheck = validateDeploymentResponse(deployment);
  if (deploymentCheck !== null) {
    fail(deploymentCheck);
    return 1;
  }
  const deploymentRecord = /** @type {{ id: number }} */ (deployment);
  if (deploymentRecord.id !== deploymentId) {
    fail("deployment-id-mismatch");
    return 1;
  }
  const deploymentEvidence = /** @type {{ id: number, sha: string, environment: string } } */ (
    deployment
  );

  const statusesOutcome = await fetchAllStatuses(repo, deploymentRecord.id, token);
  if ("error" in statusesOutcome) {
    fail(statusesOutcome.error);
    return 1;
  }

  const resolution = resolveUrlRoles({
    expectedDeploymentId: deploymentId,
    expectedSha: process.env.DEPLOYMENT_SHA ?? "",
    expectedEnvironment: process.env.DEPLOYMENT_ENVIRONMENT ?? "",
    deployment: deploymentEvidence,
    statuses: statusesOutcome.statuses,
    eventUrl: process.env.EVENT_URL ?? "",
  });

  if (resolution.state === "waiting") {
    // Waiting: ready=false + reason only — no URL outputs; exit 0.
    console.log(`ready=false`);
    console.log(`reason=${resolution.reason}`);
    writeOutput("ready", "false");
    writeOutput("reason", resolution.reason);
    return 0;
  }
  if (resolution.state === "invalid") {
    fail(resolution.reason);
    return 1;
  }

  console.log(`ready=true`);
  console.log(`reason=${resolution.reason}`);
  console.log(`verification_url=${resolution.verificationUrl}`);
  console.log(`monitoring_url=${resolution.monitoringUrl}`);
  writeOutput("ready", "true");
  writeOutput("reason", resolution.reason);
  writeOutput("verification_url", resolution.verificationUrl);
  writeOutput("monitoring_url", resolution.monitoringUrl);
  return 0;
}

/* c8 ignore start — script-entry guard: never executes on import. */
if (process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => { process.exitCode = code; },
    () => {
      // Stable evidence only — never exception details.
      fail("runner-failed");
      process.exitCode = 1;
    },
  );
}
/* c8 ignore stop */
