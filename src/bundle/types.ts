// Bundle schema v3 — what `verify-fix bundle` generates (BRAINSTORM Part 3.3).
// v2 (hand-written manifests + app-sim.ts) stays readable by `verify` until
// Phase 3 migrates the verifier onto this format.

import type { SceneType } from "../types.ts";
import type { AssertionInventory } from "../types.ts";
import type { ReproductionMode } from "./rca-mode.ts";

export type SceneMode = "live" | "live-concurrent:2" | "replay:failing.har" | "replay:passing.har" | `inject:${string}`;

export interface SceneV3 {
  sceneId: string;
  type: SceneType;
  /** how the scene is run — the generic scene layer (Phase 3/4) reads this */
  mode: SceneMode;
  /** when mode is "both" for REPRODUCTION, the alternative mode */
  alternativeMode?: SceneMode;
  state: string;
  verdict: {
    mustFail: boolean;
    provenance: { kind: "recorded"; runId: string; artifactId: string } | { kind: "code"; assertionId: string };
    envAssumptions: string[];
  };
  experiments: Array<{ durationSec: number; repetitions: number; expectStable: boolean }>;
  assertionsInvolved: string[];
  /** where the evidence for this scene comes from (report column, D3) */
  environment: "target" | "recording" | "target+recording";
  notes?: string[];
}

export interface ResultRef {
  id: string;
  startedAt: string;
  stoppedAt: string | null;
  runLocation: string;
  resultType: string | null;
  attempts: number | null;
  errorGroupIds: string[];
  /** error messages (first 2000 chars each) */
  errors: string[];
  /** the failing test, when the result names it (Playwright results do) */
  failingTest: { file: string | null; title: string | null; project: string | null; line: number | null; column: number | null } | null;
  trace: { files: string[]; entries: number; actions: number } | null;
}

export interface FailurePoint {
  action: { apiName: string; title: string; error: string } | null;
  request: { method: string; url: string; path: string; status: number; passingStatus: number | null; failureText: string | null } | null;
  /** the spec line of the failing expect(), and the inventory assertion on that line */
  assertion: { file: string | null; line: number; column: number | null; assertionId: string | null } | null;
  /**
   * When no request failed (drift: the app answered everything, the check
   * went stale), the request the failing assertion depends on: the last API
   * call before the same step in the PASSING run. Breaking it is the detection
   * scene — a repaired check must still fail when that call fails.
   */
  dependency: { method: string; url: string; path: string; passingStatus: number; msBeforeStep: number; stepLine: number | null; stepTitle: string } | null;
}

/** Another run of the same check whose time window intersects the failing run's. */
export interface OverlappingRun {
  runId: string;
  runLocation: string;
  startedAt: string;
  stoppedAt: string | null;
  /** how many ms before the failing run this one started (negative = after) */
  startDeltaMs: number;
  overlapMs: number | null;
  passed: boolean;
}

export interface DeterminismV3 {
  measured: boolean;
  /** checkly-cloud is recorded during bundle; local-runner is written by `measure`. */
  method?: "checkly-cloud" | "local-runner" | null;
  history: {
    window: number;
    finalRuns: number;
    passed: number;
    failed: number;
    passRate: number | null;
    byLocation: Record<string, { runs: number; passed: number }>;
    from: string | null;
    to: string | null;
  };
  sequential: { runs: number; passed: number; passRate: number; sessions: string[] } | null;
  overlap: { pairs: number; pairsWithFailure: number; failRate: number; sessions: string[] } | null;
  lastVerifiedAt: string;
}

export interface ManifestV3 {
  schemaVersion: "v3";
  generatedBy: string;
  generatedAt: string;
  incidentId: string;
  incident: { title: string; description: string; sourceReference: string | null; status: "captured" | "no-failure-yet" };
  check: {
    id: string;
    name: string;
    checkType: string;
    repo: string | null;
    /** primary check file under check/ (the one the inventory is built from) */
    file: string | null;
    files: string[];
    logicalId: string | null;
    deployedId: string;
    projectCommit: string | null;
  };
  config: {
    frequencyMinutes: number | null;
    locations: string[];
    privateLocations: string[];
    runParallel: boolean;
    retryStrategy: Record<string, unknown> | null;
    doubleCheck: boolean | null;
    activated: boolean;
    muted: boolean;
    tags: string[];
    runtimeId: string | null;
    environmentVariables: Array<{ key: string; secret: boolean }>;
    playwright: { configPath: string | null; projects: string[]; tags: string[]; version: string | null; source: "api" | "project" | null } | null;
    apiRequest: { method: string | null; url: string | null; assertions: unknown[] } | null;
    /**
     * What the customer told Rocky about this check. Recorded as evidence so a
     * patch can be read next to the customer's own `mustPreserve` statements;
     * the verdict never depends on it. `aiAutoRepairEnabled: null` = inherits
     * the account default.
     */
    repair: {
      intent: { goal: string; requiredOutcomes: string[]; mustPreserve: string[] } | null;
      aiAutoRepairEnabled: boolean | null;
    };
  };
  target: {
    resolution: "code" | "handlebars" | "unknown";
    variable: "ENVIRONMENT_URL";
    recordedOrigin: string | null;
    note: string;
  };
  results: { failing: ResultRef | null; passing: ResultRef | null };
  rca: {
    id: string;
    createdAt: string;
    classification: string;
    rootCause: string;
    userImpact: string;
    codeFix: string | null;
    evidence: Array<{ description: string; artifacts: Array<{ name: string; type: string }> }>;
    repairRecommendation: string | null;
    provider: string;
    model: string;
    /**
     * Rocky analyzes only the FIRST failure of an error group. Checkly groups
     * by a cleaned message, so a later, different failure (e.g. "element not
     * found" after a UI change) can land in an older group and inherit an RCA
     * that describes another incident. Both fields are arithmetic/string
     * checks, recorded so the reader knows how much the RCA is worth here.
     */
    createdBeforeFailingRun: boolean | null;
    /** true = the group's first "Received" matches this run's; false = it differs; null = not comparable */
    groupErrorMatchesFailingRun: boolean | null;
    /** does Rocky's text mention what this run received (normalized substring)? null = run has no Received */
    mentionsFailingRunReceived: boolean | null;
    /**
     * true = positive evidence (the text mentions what this run received, or the
     * group's first failure matches this run); false = the RCA predates this run
     * and is about a different failure; null = not decidable from the outside.
     */
    describesFailingRun: boolean | null;
    /** the RCA this one replaced when `--trigger-rca` requested a fresh analysis */
    replaced: { id: string; createdAt: string; classification: string } | null;
  } | null;
  errorGroup: { id: string; cleanedErrorMessage: string; firstSeen: string; lastSeen: string } | null;
  reproduction: {
    mode: ReproductionMode;
    /** "overlapping-run" (result timestamps) or an RCA text rule, or null */
    matchedRule: string | null;
    matchedText: string | null;
    reason: string;
    /** which kind of evidence decided the mode */
    decidedBy: "result-timestamps" | "history" | "rca-text" | "error-group-text" | "none";
    overlappingRuns: OverlappingRun[];
  };
  failurePoint: FailurePoint | null;
  recordings: { failing: string | null; passing: string | null; bodies: string };
  scenes: SceneV3[];
  assertions: AssertionInventory | null;
  envAssumptions: Array<{ id: string; text: string; verified: boolean; verifiedBy: string }>;
  determinism: DeterminismV3;
  runBudget: { maxPerScene: number; used: number };
  oracleProvenance: { recorded: number; codeDerived: number };
  provenance: {
    accountIdHash: string;
    checkId: string;
    failingResultId: string | null;
    passingResultId: string | null;
    errorGroupId: string | null;
    rcaId: string | null;
    assets: Array<{ result: "failing" | "passing"; name: string; type: string; bytes: number; sha256: string }>;
    apiCalls: Array<{ method: string; url: string; status: number }>;
  };
  notes: string[];
}
