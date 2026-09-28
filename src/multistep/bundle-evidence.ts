// Multistep bundles are constructed as a fresh allow-list projection. Nothing
// supplied by a remote result, RCA, asset URL, log or arbitrary manifest field
// is spread into stored metadata. The check/ source remains separate code;
// the bundle writer validates/bounds that closure before writing it.
import type { ManifestV3, SceneV3, ResultRef, FailurePoint, OverlappingRun } from "../bundle/types.ts";
import type { CheckResultSummary } from "../checkly/types.ts";
import type { MultiStepRecording } from "./capture.ts";
import { failurePointFromRecording, matchesRemoteMultiStepBinding } from "./binding.ts";
import { parseMultiStepProject } from "./source.ts";
import { knownRoute, knownStepTitle, MULTISTEP_ROUTES } from "./routes.ts";
import { multiStepSourcePath } from "./files.ts";

const ASSET_NAMES = new Set(["test-results.json", "check-run-data.json", "logs.txt"]);
const API_OPERATIONS = new Set(["asset", "get-check", "list-results", "list-assets", "get-result", "error-group", "rca"]);
const SAFE_ASSUMPTIONS = new Set(["locations", "run-parallel", "env-vars", "target-resolution", "overlapping-run"]);
const TRUSTED_LOCATIONS = new Set(["us-east-1", "eu-west-1"]);
const TRUSTED_ENV_KEYS = new Set(["ENVIRONMENT_URL", "MULTISTEP_USER_US_EAST_1", "MULTISTEP_USER_EU_WEST_1"]);
const safeLocation = (value: string): string => TRUSTED_LOCATIONS.has(value) ? value : "<unknown-location>";
const safeId = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
const safeDate = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const count = (value: unknown, max = 1_000_000): number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max ? value as number : 0;
const rate = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const assertionIds = (values: string[]): string[] => values.filter((id) => /^assert:[0-9a-f]{8}$/.test(id)).slice(0, 200);

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

function ref(input: ResultRef | null): ResultRef | null {
  if (!input) return null;
  return {
    id: safeId(input.id) ?? "<unrecognized-id>",
    startedAt: safeDate(input.startedAt) ?? "<unknown-timestamp>",
    stoppedAt: safeDate(input.stoppedAt),
    runLocation: safeLocation(input.runLocation),
    resultType: input.resultType === "FINAL" ? "FINAL" : null,
    attempts: input.attempts === null ? null : count(input.attempts, 100),
    errorGroupIds: [], errors: [], failingTest: null, trace: null,
  };
}

function sceneProjection(scene: SceneV3, manifest: ManifestV3,
  available: { failing: boolean; passing: boolean }, point: FailurePoint | null): SceneV3 | null {
  if (!["HEALTHY", "REPRODUCTION", "DETECTION"].includes(scene.type)
    || scene.sceneId !== (scene.type === "HEALTHY" ? "healthy-live"
      : scene.type === "REPRODUCTION" ? "reproduction" : "detection")) return null;
  const provenance = scene.verdict.provenance;
  let proof: SceneV3["verdict"]["provenance"];
  if (provenance.kind === "recorded") {
    const side = provenance.artifactId === "recordings/failing.multistep.json" ? "failing"
      : provenance.artifactId === "recordings/passing.multistep.json" ? "passing" : null;
    if (!side || !available[side] || !manifest.results[side] || provenance.runId !== manifest.results[side]!.id
      || (scene.type === "HEALTHY" ? side !== "passing" : side !== "failing")) return null;
    proof = { kind: "recorded", runId: provenance.runId, artifactId: provenance.artifactId };
  } else return null; // no code or generic-manifest fallback for a remote run

  let mode: SceneV3["mode"];
  if (scene.type === "HEALTHY") mode = "live";
  else if (scene.type === "REPRODUCTION") {
    if (scene.mode !== "live" && scene.mode !== "live-concurrent:2") return null;
    mode = scene.mode;
  } else {
    const req = point?.request ?? point?.dependency;
    const route = knownRoute(req?.path);
    if (!route || route !== "/api/book" || !req || req.method !== "POST" || proof.kind !== "recorded"
      || point?.request !== null || !point.assertion) return null;
    mode = "inject:POST /api/book -> 500";
  }
  const isDetection = scene.type === "DETECTION";
  return {
    sceneId: scene.sceneId, type: scene.type, mode,
    state: `Multistep ${scene.type.toLowerCase()} state; raw diagnostics omitted.`,
    verdict: { mustFail: isDetection, provenance: proof,
      envAssumptions: scene.verdict.envAssumptions.filter((id) => SAFE_ASSUMPTIONS.has(id)) },
    experiments: scene.experiments.slice(0, 1).map((e) => ({ durationSec: count(e.durationSec, 300), repetitions: count(e.repetitions, 10), expectStable: e.expectStable === true })),
    assertionsInvolved: assertionIds(scene.assertionsInvolved),
    environment: "target", notes: [],
  };
}

/** Replace the input object; never mutate-and-retain unknown fields. The
 * optional captures are already sanitized, typed, and selected by result side.
 * An absent side never receives a pointer or scene from the opposite side. */
export function constrainMultiStepManifest(m: ManifestV3,
  recordings: Partial<Record<"failing" | "passing", MultiStepRecording>> = {},
  sources: Map<string, string> = new Map()): ManifestV3 {
  if (m.check.checkType !== "MULTI_STEP") return m;
  const failing = ref(m.results.failing);
  const passing = ref(m.results.passing);
  const paths = m.check.files.filter((file) => multiStepSourcePath(file) === file).slice(0, 32);
  const primary = m.check.file && paths.includes(m.check.file) ? m.check.file : null;
  const sourceText = primary ? sources.get(primary) : null;
  const sourceModel = primary && sourceText ? parseMultiStepProject(sources, primary) : null;
  const invalidAsset = m.provenance.assets.some((asset) => !ASSET_NAMES.has(asset.name)
    || (asset.type !== "local-asset" && asset.type !== "remote-asset"
      || asset.type === "remote-asset" && (asset.assetType !== "report" && asset.assetType !== "file"
        && !(asset.name === "logs.txt" && asset.assetType === "log")
        || !/^[a-f0-9]{64}$/.test(asset.manifestEntrySha256 ?? ""))));
  const available = {
    failing: false, passing: false,
  };
  for (const side of ["failing", "passing"] as const) {
    const result = side === "failing" ? failing : passing;
    const pointer = side === "failing" ? m.recordings.multistepFailing : m.recordings.multistepPassing;
    const asset = m.provenance.assets.filter((item) => item.result === side && item.name === "test-results.json");
    available[side] = !invalidAsset && Boolean(recordings[side] && result && primary && sourceText
      && pointer === `recordings/${side}.multistep.json` && asset.length === 1
      && matchesRemoteMultiStepBinding(recordings[side]!, {
        side, checkId: m.check.id, result: result!, sourceFile: primary!, sourceText: sourceText!,
        sourceModel, asset: asset[0]!,
      }));
  }
  const point = available.failing && primary ? failurePointFromRecording(recordings.failing!, primary) : null;
  // A missing/invalid failing recording cannot be laundered by a passing run
  // into an incident scene. Nothing in the generic manifest can create one.
  const scenes = failing && !available.failing ? []
    : m.scenes.flatMap((scene) => sceneProjection(scene, m, available, point) ?? []);
  const problems = (side: "failing" | "passing"): { problems: string[] } | null => {
    const selected = m.multistep?.[side]?.problems.filter((item) => /^MULTISTEP_[A-Z_]+$/.test(item)).slice(0, 16) ?? [];
    if (invalidAsset) selected.push("MULTISTEP_ASSET_TYPE_INVALID");
    if (m.results[side] && !available[side]) selected.push("MULTISTEP_CAPTURE_BINDING_INVALID");
    if (side === "failing" && available.failing && !point?.assertion) selected.push("MULTISTEP_FAILURE_STEP_UNBOUND");
    if (side === "failing" && available.failing && !scenes.some((scene) => scene.type === "DETECTION")) selected.push("MULTISTEP_FAILURE_STEP_UNBOUND");
    return selected.length ? { problems: [...new Set(selected)] } : null;
  };
  const history = m.determinism.history;
  const overlappingRuns: OverlappingRun[] = m.reproduction.overlappingRuns.slice(0, 100).flatMap((run) => {
    const start = safeDate(run.startedAt);
    const stop = run.stoppedAt === null ? null : safeDate(run.stoppedAt);
    if (!start || (run.stoppedAt !== null && !stop)
      || typeof run.startDeltaMs !== "number" || !Number.isFinite(run.startDeltaMs) || Math.abs(run.startDeltaMs) >= 1e9
      || (run.overlapMs !== null && (!Number.isSafeInteger(run.overlapMs) || run.overlapMs < 0 || run.overlapMs >= 1e9))) {
      return []; // an invalid clock never becomes a fabricated zero interval
    }
    return [{ runId: safeId(run.runId) ?? "<unrecognized-id>", runLocation: safeLocation(run.runLocation),
      startedAt: start, stoppedAt: stop, startDeltaMs: run.startDeltaMs,
      overlapMs: run.overlapMs, passed: run.passed === true }];
  });
  const projected: ManifestV3 = {
    schemaVersion: "v3", generatedBy: "verify-fix bundle", generatedAt: safeDate(m.generatedAt) ?? "1970-01-01T00:00:00.000Z",
    incidentId: `multistep:${safeId(m.check.id) ?? "unknown"}:${safeId(failing?.id ?? passing?.id) ?? "unknown"}`,
    incident: { title: failing ? "Multistep check incident" : "Multistep check baseline",
      description: failing ? "Recorded Multistep failure; raw diagnostics and RCA omitted." : "Recorded Multistep baseline; raw diagnostics omitted.",
      sourceReference: null, status: failing ? "captured" : "no-failure-yet" },
    check: { id: safeId(m.check.id) ?? "<unrecognized-id>", deployedId: safeId(m.check.deployedId) ?? "<unrecognized-id>",
      name: "Multistep check", checkType: "MULTI_STEP", repo: null, file: primary, files: paths,
      logicalId: safeId(m.check.logicalId), projectCommit: /^[a-f0-9]{40}$/.test(m.check.projectCommit ?? "") ? m.check.projectCommit : null },
    config: {
      frequencyMinutes: m.config.frequencyMinutes === null ? null : count(m.config.frequencyMinutes, 1440),
      locations: m.config.locations.map(safeLocation).slice(0, 2), privateLocations: [], runParallel: m.config.runParallel === true,
      retryStrategy: null, doubleCheck: typeof m.config.doubleCheck === "boolean" ? m.config.doubleCheck : null,
      activated: m.config.activated === true, muted: m.config.muted === true, tags: [], runtimeId: null,
      environmentVariables: m.config.environmentVariables.filter((entry) => TRUSTED_ENV_KEYS.has(entry.key))
        .map((entry) => ({ key: entry.key, secret: entry.secret === true })),
      playwright: null, apiRequest: null,
      repair: { intent: null, aiAutoRepairEnabled: typeof m.config.repair.aiAutoRepairEnabled === "boolean" ? m.config.repair.aiAutoRepairEnabled : null },
    },
    target: { resolution: m.target.resolution === "code" ? "code" : "unknown", variable: "ENVIRONMENT_URL", recordedOrigin: null,
      note: "The runner derives ENVIRONMENT_URL from the explicit target; no recorded origin is retained." },
    results: { failing, passing }, rca: null, errorGroup: null,
    reproduction: { mode: m.reproduction.mode === "live-concurrent:2" ? "live-concurrent:2" : m.reproduction.mode === "live" ? "live" : "both",
      matchedRule: null, matchedText: null, reason: "Multistep mode derived from typed result history; raw diagnostic text omitted.",
      decidedBy: m.reproduction.decidedBy === "result-timestamps" || m.reproduction.decidedBy === "history" ? m.reproduction.decidedBy : "none",
      overlappingRuns },
    failurePoint: point,
    recordings: { failing: null, passing: null, bodies: "none", apiFailing: null, apiPassing: null,
      multistepFailing: available.failing ? "recordings/failing.multistep.json" : null,
      multistepPassing: available.passing ? "recordings/passing.multistep.json" : null },
    multistep: { failing: problems("failing"), passing: problems("passing") },
    scenes, assertions: null,
    envAssumptions: m.envAssumptions.filter((item) => SAFE_ASSUMPTIONS.has(item.id)).map((item) => ({
      id: item.id, verified: item.verified === true,
      verifiedBy: item.verifiedBy === "result-timestamps" ? "result-timestamps" : "source-policy",
      text: item.id === "locations" ? "Two locations are configured." : item.id === "run-parallel" ? "The check is configured to run in parallel."
        : item.id === "env-vars" ? "Only environment variable names are retained." : item.id === "target-resolution" ? "An explicit target is required."
          : "An overlapping run was observed in the result timestamps.",
    })),
    determinism: { measured: m.determinism.measured === true,
      method: m.determinism.method === "checkly-cloud" || m.determinism.method === "local-runner" ? m.determinism.method : null,
      history: { window: count(history.window), finalRuns: count(history.finalRuns), passed: count(history.passed), failed: count(history.failed),
        passRate: rate(history.passRate), byLocation: Object.fromEntries(Object.entries(history.byLocation)
          .filter(([loc]) => TRUSTED_LOCATIONS.has(loc))
          .map(([loc, value]) => [loc, { runs: count(value.runs), passed: count(value.passed) }])),
        from: safeDate(history.from), to: safeDate(history.to) },
      sequential: m.determinism.sequential ? { runs: count(m.determinism.sequential.runs), passed: count(m.determinism.sequential.passed),
        passRate: rate(m.determinism.sequential.passRate) ?? 0, sessions: m.determinism.sequential.sessions.flatMap((id) => safeId(id) ?? []) } : null,
      overlap: m.determinism.overlap ? { pairs: count(m.determinism.overlap.pairs), pairsWithFailure: count(m.determinism.overlap.pairsWithFailure),
        failRate: rate(m.determinism.overlap.failRate) ?? 0, sessions: m.determinism.overlap.sessions.flatMap((id) => safeId(id) ?? []) } : null,
      lastVerifiedAt: safeDate(m.determinism.lastVerifiedAt) ?? "1970-01-01T00:00:00.000Z" },
    runBudget: { maxPerScene: count(m.runBudget.maxPerScene, 10), used: count(m.runBudget.used, 10) },
    oracleProvenance: { recorded: scenes.filter((scene) => scene.verdict.provenance.kind === "recorded").length,
      codeDerived: scenes.filter((scene) => scene.verdict.provenance.kind === "code").length },
    provenance: { accountIdHash: /^[a-f0-9]{8}$/.test(m.provenance.accountIdHash) ? m.provenance.accountIdHash : "00000000",
      checkId: safeId(m.check.id) ?? "<unrecognized-id>", failingResultId: failing?.id ?? null, passingResultId: passing?.id ?? null,
      errorGroupId: null, rcaId: null,
      assets: m.provenance.assets.filter((asset) => (asset.result === "failing" || asset.result === "passing")
        && ASSET_NAMES.has(asset.name) && /^[a-f0-9]{64}$/.test(asset.sha256)
        && (asset.type === "local-asset" || asset.type === "remote-asset")
        && Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && asset.bytes <= 64 * 1024 * 1024)
        .map((asset) => asset.type === "remote-asset" ? ({
          result: asset.result, name: asset.name, type: "remote-asset", bytes: asset.bytes, sha256: asset.sha256,
          resultId: safeId(asset.resultId) ?? undefined, assetType: asset.assetType,
          manifestEntrySha256: asset.manifestEntrySha256,
        }) : ({ result: asset.result, name: asset.name, type: "local-asset", bytes: asset.bytes, sha256: asset.sha256 })),
      apiCalls: m.provenance.apiCalls.slice(0, 1000).map((call) => ({ method: call.method === "GET" || call.method === "POST" ? call.method : "OTHER",
        url: API_OPERATIONS.has(call.url) ? call.url : "<checkly-request>", status: count(call.status, 599) })) },
    notes: ["Multistep evidence uses fixed routes, typed bodies, source bindings and error categories. Locally constructed fixtures prove mechanics only."],
  };
  return projected;
}
