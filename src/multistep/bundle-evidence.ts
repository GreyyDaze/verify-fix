// A MULTI_STEP bundle is an evidence object, not a dump of Checkly's result
// document. Keep only typed run metadata, fixed incident/scene categories and
// the independently sanitized recording; omit error strings, page URLs, trace
// metadata, RCA prose, arbitrary remote asset URLs and free-form warnings.
// The original check source in check/ is code (needed for the contract), not
// telemetry, and is deliberately not rewritten by this projection.
import type { ManifestV3 } from "../bundle/types.ts";
import type { CheckResultSummary } from "../checkly/types.ts";
import { knownRoute } from "./routes.ts";

const ASSET_NAMES = new Set(["test-results.json", "check-run-data.json", "logs.txt"]);
const SAFE_ASSUMPTIONS = new Set(["locations", "run-parallel", "env-vars", "target-resolution", "overlapping-run"]);
const TRUSTED_LOCATIONS = new Set(["us-east-1", "eu-west-1"]);
const TRUSTED_ENV_KEYS = new Set(["ENVIRONMENT_URL", "MULTISTEP_USER_US_EAST_1", "MULTISTEP_USER_EU_WEST_1"]);
const safeLocation = (value: string): string => TRUSTED_LOCATIONS.has(value) ? value : "<unknown-location>";
const safeId = (value: string | null): string | null => value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
const safeDate = (value: string | null): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** A result JSON is a typed run summary, never a raw Checkly detail. */
export function multiStepRunMetadata(summary: CheckResultSummary): Record<string, unknown> {
  return {
    id: safeId(summary.id) ?? "<unrecognized-id>",
    runLocation: safeLocation(summary.runLocation),
    startedAt: safeDate(summary.startedAt) ?? "<unknown-timestamp>",
    stoppedAt: safeDate(summary.stoppedAt ?? null),
    hasFailures: summary.hasFailures === true,
    hasErrors: summary.hasErrors === true,
    attempts: Number.isSafeInteger(summary.attempts) && (summary.attempts ?? 0) >= 0 && (summary.attempts ?? 0) <= 100 ? summary.attempts : null,
    resultType: summary.resultType === "FINAL" ? "FINAL" : null,
    errorCategory: summary.hasFailures || summary.hasErrors ? "MULTISTEP_RUN_FAILED" : "MULTISTEP_RUN_PASSED",
  };
}

export function constrainMultiStepManifest(manifest: ManifestV3): ManifestV3 {
  if (manifest.check.checkType !== "MULTI_STEP") return manifest;
  manifest.incidentId = `multistep:${safeId(manifest.check.id) ?? "unknown"}:${safeId(manifest.results.failing?.id ?? manifest.results.passing?.id ?? null) ?? "unknown"}`;
  manifest.incident.title = manifest.results.failing ? "Multistep check incident" : "Multistep check baseline";
  manifest.incident.description = manifest.results.failing
    ? "Recorded Multistep failure; raw result errors and RCA text omitted. See sanitized step and request categories."
    : "Recorded Multistep baseline; raw result details omitted.";
  manifest.incident.sourceReference = null;
  manifest.check.repo = null;
  manifest.check.id = safeId(manifest.check.id) ?? "<unrecognized-id>";
  manifest.check.deployedId = safeId(manifest.check.deployedId) ?? "<unrecognized-id>";
  manifest.config.locations = manifest.config.locations.map(safeLocation);
  manifest.config.environmentVariables = manifest.config.environmentVariables.filter((entry) => TRUSTED_ENV_KEYS.has(entry.key));
  manifest.config.privateLocations = [];
  manifest.config.retryStrategy = null;
  manifest.config.tags = [];
  manifest.config.runtimeId = null;
  manifest.config.repair.intent = null;
  manifest.target.recordedOrigin = null;
  manifest.target.note = "The runner derives ENVIRONMENT_URL from the explicit target; recorded origins are not retained.";
  for (const ref of [manifest.results.failing, manifest.results.passing]) {
    if (!ref) continue;
    ref.id = safeId(ref.id) ?? "<unrecognized-id>";
    ref.runLocation = safeLocation(ref.runLocation);
    ref.startedAt = safeDate(ref.startedAt) ?? "<unknown-timestamp>";
    ref.stoppedAt = safeDate(ref.stoppedAt);
    ref.resultType = ref.resultType === "FINAL" ? "FINAL" : null;
    ref.attempts = Number.isSafeInteger(ref.attempts) && (ref.attempts ?? 0) >= 0 && (ref.attempts ?? 0) <= 100 ? ref.attempts : null;
    ref.errors = [];
    ref.failingTest = null;
    ref.trace = null;
    ref.errorGroupIds = [];
  }
  manifest.rca = null;
  manifest.errorGroup = null;
  manifest.provenance.checkId = safeId(manifest.provenance.checkId) ?? "<unrecognized-id>";
  manifest.provenance.failingResultId = safeId(manifest.provenance.failingResultId);
  manifest.provenance.passingResultId = safeId(manifest.provenance.passingResultId);
  manifest.provenance.errorGroupId = null;
  manifest.provenance.rcaId = null;
  manifest.reproduction.overlappingRuns = manifest.reproduction.overlappingRuns.map((run) => ({
    ...run, runId: safeId(run.runId) ?? "<unrecognized-id>",
    runLocation: safeLocation(run.runLocation),
    startedAt: safeDate(run.startedAt) ?? "<unknown-timestamp>",
    stoppedAt: safeDate(run.stoppedAt),
  }));
  const history = manifest.determinism.history;
  history.byLocation = Object.fromEntries(Object.entries(history.byLocation)
    .filter(([name]) => TRUSTED_LOCATIONS.has(name)));
  history.from = safeDate(history.from);
  history.to = safeDate(history.to);
  if (manifest.determinism.sequential) manifest.determinism.sequential.sessions = manifest.determinism.sequential.sessions.flatMap((id) => safeId(id) ?? []);
  if (manifest.determinism.overlap) manifest.determinism.overlap.sessions = manifest.determinism.overlap.sessions.flatMap((id) => safeId(id) ?? []);
  manifest.provenance.apiCalls = manifest.provenance.apiCalls.map((call) => ({
    method: call.method === "GET" || call.method === "POST" ? call.method : "OTHER",
    url: "<checkly-request>", status: call.status,
  }));
  manifest.provenance.assets = manifest.provenance.assets.map((asset) => ({
    result: asset.result,
    name: ASSET_NAMES.has(asset.name) ? asset.name : "<unknown-asset>",
    type: asset.type === "local-asset" ? "local-asset" : "remote-asset",
    bytes: asset.bytes, sha256: asset.sha256,
  }));
  manifest.reproduction.matchedText = null;
  manifest.reproduction.reason = "Multistep reproduction mode derived from run history; raw diagnostic text omitted.";
  // A missing capture does NOT acquire provenance from an unrelated side.
  // The loader checks the expected side even if a manifest pointer is removed.
  for (const scene of manifest.scenes) {
    scene.state = `Multistep ${scene.type.toLowerCase()} state; raw diagnostic text omitted.`;
    if (scene.verdict.provenance.kind === "recorded") {
      scene.verdict.provenance.runId = safeId(scene.verdict.provenance.runId) ?? "<unrecognized-id>";
      const artifact = scene.verdict.provenance.artifactId;
      if (artifact !== "recordings/failing.multistep.json" && artifact !== "recordings/passing.multistep.json") {
        scene.verdict.provenance.artifactId = scene.type === "HEALTHY"
          ? "recordings/passing.multistep.json" : "recordings/failing.multistep.json";
      }
    }
    scene.notes = [];
    scene.verdict.envAssumptions = scene.verdict.envAssumptions.filter((id) => id !== "shared-account");
  }
  manifest.envAssumptions = manifest.envAssumptions.filter((item) => SAFE_ASSUMPTIONS.has(item.id)).map((item) => ({
    id: item.id,
    text: item.id === "locations" ? "The check has configured locations." :
      item.id === "run-parallel" ? "The check is configured to run in parallel." :
      item.id === "env-vars" ? "Environment variable names are recorded; values are omitted." :
      item.id === "target-resolution" ? "The script reads ENVIRONMENT_URL; the target must be explicit." :
      "Run timestamps show an overlapping execution.",
    verified: item.verified, verifiedBy: item.verifiedBy,
  }));
  if (manifest.failurePoint) {
    const point = manifest.failurePoint;
    if (point.request && !knownRoute(point.request.path)) point.request = null;
    if (point.dependency && !knownRoute(point.dependency.path)) point.dependency = null;
    // Even an error object returned by the result API is never copied into a
    // scene or README. The sanitized step category is all that is retained.
    if (point.action) point.action = { apiName: "test.step", title: point.action.title, error: point.action.error === "ASSERTION_FAILED" ? "ASSERTION_FAILED" : "STEP_ERROR" };
    if (point.request) point.request.failureText = "REQUEST_FAILURE";
  }
  manifest.notes = ["Multistep evidence uses fixed route/body schemas and error categories; raw diagnostics omitted."];
  return manifest;
}
