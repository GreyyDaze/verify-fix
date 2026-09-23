// verify-fix core types. Port of bundle schema v2 (prod PRD §7) plus judgment types.
// The oracle has exactly two legal provenance sources (PR-3): recorded Checkly
// outcomes ("recorded:<runId>") and check-code assertions ("code:assert:<id>").
// Anything else is rejected at ingestion.

export type SceneType = "REPRODUCTION" | "HEALTHY" | "DETECTION" | "MUTATION" | "REGRESSION";

export type VerdictProvenance =
  | ({ kind: "recorded"; runId: string; artifactId: string })
  | ({ kind: "code"; assertionId: string });

export type ExitCode = 0 | 1 | 2;

export type VerdictValue = "PASS" | "FAILED" | "UNCERTAIN";

/** What an oracle expects of a scene: binary by construction (PR-3). */
export type OracleExpectation = "pass" | "fail";

/**
 * What an executor actually observed. `uncertain` is the third, mandatory
 * value: the run produced no admissible evidence (the check never contacted
 * the armed app, repetitions disagreed, the budget was exhausted, the sandbox
 * crashed). It is never a match and never a mismatch — the decision table
 * maps it to UNCERTAIN so a hitless run can never satisfy an oracle.
 */
export type ObservationValue = "pass" | "fail" | "uncertain";

export interface SceneVerdict {
  /** true = the fixed check must FAIL in this state; false = must PASS. */
  mustFail: boolean;
  provenance: VerdictProvenance;
  envAssumptions: string[];
}

export interface Scene {
  sceneId: string;
  type: SceneType;
  /** What state the target is in for this scene (prose, for the report). */
  state: string;
  /**
   * How the scene layer puts the target into that state (src/scene/modes.ts):
   * `live`, `live-concurrent:N`, `replay:<file>.har`, `inject:<METHOD> <path> -> <status>`.
   */
  mode: string;
  /** REPRODUCTION scenes may name a second way to reproduce (used when the first cannot run). */
  alternativeMode?: string;
  /** where the evidence comes from (report column) */
  environment?: "target" | "recording" | "target+recording";
  /** scene-specific variables layered over the run environment (e.g. a second user for a regression scene) */
  env?: Record<string, string>;
  verdict: SceneVerdict;
  experiments: Array<{ durationSec: number; repetitions: number; expectStable: boolean }>;
  assertionsInvolved: string[];
  notes?: string[];
}

export interface EnvAssumption {
  id: string;
  text: string;
  verified: boolean;
  verifiedBy?: string;
}

export interface DeterminismEvidence {
  targetRuns: number;
  achieved: number;
  /** Legacy capture fields, kept for v2 bundles and reports. */
  sequentialPassRate: number;
  overlapFailRate: number;
  /** Rate at which the original check reproduced the incident's own mode. */
  reproductionFailRate?: number;
  /** One-at-a-time healthy rate. Only required for concurrency incidents. */
  baselinePassRate?: number | null;
  /** Where the measured numbers came from. */
  method?: "checkly-cloud" | "local-runner" | null;
  lastVerifiedAt: string;
}

export interface RunBudget {
  maxPerScene: number;
  used: number;
}

export interface CheckInfo {
  repo: string;
  file: string;
  /** Display name used by `checkly test --grep` to select only this check. */
  name?: string;
  logicalId: string;
  deployedId: string | null;
}

/** The check's scheduling/config as it ran (from checkly.config.ts / the construct / the API). */
export interface BundleConfig {
  runParallel: boolean;
  locations: string[];
  frequencyMinutes: number | null;
  /** keys only — values never enter a bundle */
  environmentVariables: string[];
}

export interface Bundle {
  schemaVersion: "v2" | "v3";
  incidentId: string;
  incident: { title: string; description: string; sourceReference?: string };
  check: CheckInfo;
  /** The check source AS IT RAN when the failure was recorded (the "original"). */
  checkSource: string;
  /** every file under check/ (path → content); a directory patch may replace any of them */
  files: Record<string, string>;
  /** the config file among `files`, when there is one (checkly.config.ts) */
  configFile: string | null;
  config: BundleConfig | null;
  /** origin the failing run was recorded against (null = unknown); never used as a live target by itself */
  recordedOrigin: string | null;
  /** absolute path of the bundle directory (recordings are resolved against it) */
  dir: string;
  /** Playwright runner details captured from Checkly/project config. */
  playwright?: { configFile: string; projects: string[] } | null;
  scenes: Scene[];
  envAssumptions: EnvAssumption[];
  determinism: DeterminismEvidence;
  runBudget: RunBudget;
  oracleProvenance: { recorded: number; codeDerived: number };
}

// ---- assertion inventory (contract engine 5.1) ----

export type AssertionKind = "exact" | "property";

export interface Assertion {
  id: string;
  subject: string;
  matcher: string;
  target: string;
  kind: AssertionKind;
  onCriticalPath: boolean;
  sourceLine: number;
  /** Whether this assertion can falsify anything (exact matchers with a concrete target). */
  falsifiable: boolean;
  /** true if wrapped in try/catch or soft/poll+catch — suppresses a real failure. */
  guarded: boolean;
}

export interface AssertionInventory {
  checkFile: string;
  assertions: Assertion[];
  /** Flow steps detected (goto/fetch/click/…), for step-removal diff. */
  steps: string[];
  /** count of assertion sources, invariant source of truth. */
  totalAssertions: number;
}

// ---- adequacy engine (5.2) ----

export interface WeaknessScan {
  insufficientInputSpace: boolean;
  partialPathCoverage: boolean;
  weakAssertions: Array<{ assertionId: string; reason: string }>;
  missingEnvContext: string[];
  operatorMutants: string[];
  llmMutants: string[];
}

export interface OracleStrength {
  score: number;
  falsifiability: number;
  coverage: number;
  envCompleteness: number;
  mutantKillRate: number;
}

// ---- experiment execution ----

export interface SceneObservation {
  sceneId: string;
  observed: ObservationValue;
  repetitions: number;
  /** every claim here must reduce to traced steps + assertion outcomes */
  trace: TraceStep[];
  source: "scene" | "checkly";
  /** what the run talked to: "target <host> (mode)" or "recording <file>" */
  environment?: string;
  /** Recorded Checkly test sessions used as evidence. */
  checklySessionIds?: string[];
  /** Individual Checkly result ids inside those sessions. */
  checklyResultIds?: string[];
  /** Mandatory when observed === "uncertain": why no pass/fail could be admitted. */
  reason?: string;
}

export interface TraceStep {
  index: number;
  kind: "step" | "assertion" | "suppression";
  what: string;
  outcome: "ok" | "failed" | "skipped";
  assertionId?: string;
}

// ---- decision ----

export type EvidenceRow = {
  experiment: string;
  /** where the evidence came from: the target host, a recording, or both (D3) */
  environment: string;
  oracle: string;
  observed: ObservationValue;
  expected: OracleExpectation;
  /** true only when observed is a real pass/fail equal to expected. */
  matched: boolean;
  strength: number;
  /** set when observed === "uncertain": the executor's stated reason. */
  note?: string;
};

export interface Decision {
  verdict: VerdictValue;
  exitCode: ExitCode;
  rows: EvidenceRow[];
  reasons: string[];
  adequacy: OracleStrength | null;
  weakness: WeaknessScan | null;
}

// ---- executor interface (interface = proves principled Checkly swap, PR-1) ----

/** What the executor knows about the candidate beyond its check code. */
export interface RunContext {
  /** the check config after the patch (scheduling decides the concurrency a scene runs at) */
  config: BundleConfig | null;
  /** Complete candidate check tree. Browser specs may import helper files from it. */
  files?: Record<string, string>;
  /** Distinguishes the candidate from generated weakening checks in cost reports. */
  phase?: "candidate" | "mutation";
}

export interface SceneCost {
  sceneId: string;
  executor: "scene" | "checkly";
  repetitions: number;
  checkRuns: number;
  wallTimeMs: number;
  phase: "candidate" | "mutation";
}

export interface ExecutionCost {
  scenes: number;
  runs: number;
  checklyTestSessions: number;
  checklyCloudRuns: number;
  checklySessionIds: string[];
  checklyResultIds: string[];
  /** Local check executions. Concurrent checks count separately. */
  localRuns: number;
  /** Browser processes started by local Playwright executions. */
  browserProcesses: number;
  mutationRuns: number;
  wallTimeMs: number;
  byScene: SceneCost[];
}

export function emptyExecutionCost(): ExecutionCost {
  return {
    scenes: 0,
    runs: 0,
    checklyTestSessions: 0,
    checklyCloudRuns: 0,
    checklySessionIds: [],
    checklyResultIds: [],
    localRuns: 0,
    browserProcesses: 0,
    mutationRuns: 0,
    wallTimeMs: 0,
    byScene: [],
  };
}

export interface ExperimentExecutor {
  readonly kind: "scene" | "checkly" | "hybrid";
  /** Run the fixed check code in one scene state and observe its outcome. */
  runScene(bundle: Bundle, patchSource: string, scene: Scene, ctx?: RunContext): Promise<SceneObservation>;
  /** True when the executor can produce live observed runs (PR-1). */
  isLive(): boolean;
  costReport(): ExecutionCost;
  /** True when the per-scene run budget was hit (PR-10 → UNCERTAIN). */
  budgetExhausted: boolean;
  /** Scene ids whose repeated observations disagreed (flake → UNCERTAIN). */
  nondeterministicScenes: string[];
  /** Executors with listeners or temporary state may release it here. */
  close?(): Promise<void>;
}
