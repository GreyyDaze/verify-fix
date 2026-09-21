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

export type ObservationValue = "pass" | "fail";

export interface SceneVerdict {
  /** true = the fixed check must FAIL in this state; false = must PASS. */
  mustFail: boolean;
  provenance: VerdictProvenance;
  envAssumptions: string[];
}

export interface Scene {
  sceneId: string;
  type: SceneType;
  /** How the app is put into this state (deterministic entrypoint). */
  state: string;
  /** Deterministic entrypoint understood by the app-under-test (see state-driver). */
  stateDriver?: { kind: "mock-override" | "app-probe"; params: Record<string, string> };
  verdict: SceneVerdict;
  experiments: Array<{ durationSec: number; repetitions: number; expectStable: boolean }>;
  assertionsInvolved: string[];
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
  sequentialPassRate: number;
  overlapFailRate: number;
  lastVerifiedAt: string;
}

export interface RunBudget {
  maxPerScene: number;
  used: number;
}

export interface CheckInfo {
  repo: string;
  file: string;
  logicalId: string;
  deployedId: string | null;
}

export interface Bundle {
  schemaVersion: "v2";
  incidentId: string;
  incident: { title: string; description: string; sourceReference?: string };
  check: CheckInfo;
  /** The check source AS IT RAN when the failure was recorded (the "original"). */
  checkSource: string;
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
  source: "synthetic" | "checkly";
  checklyRunIds?: string[];
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
  oracle: string;
  observed: ObservationValue;
  expected: ObservationValue;
  matched: boolean;
  strength: number;
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

export interface ExperimentExecutor {
  readonly kind: "synthetic" | "checkly";
  /** Run the fixed check code in one scene state and observe its outcome. */
  runScene(bundle: Bundle, patchSource: string, scene: Scene): Promise<SceneObservation>;
  /** True when the executor can produce live observed runs (PR-1). */
  isLive(): boolean;
  costReport(): { scenes: number; runs: number };
  /** True when the per-scene run budget was hit (PR-10 → UNCERTAIN). */
  budgetExhausted: boolean;
  /** Scene ids whose repeated observations disagreed (flake → UNCERTAIN). */
  nondeterministicScenes: string[];
}