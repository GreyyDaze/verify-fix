// Shapes of the Checkly Public API responses the bundle command reads.
// Field names verified against the Checkly CLI v9.5.0 (dist/rest/*.d.ts) and
// the constructs' synthesize() payloads. Only the fields we use are typed;
// everything else is carried as `unknown` and never written to the bundle.

export interface ChecklyEnvVar {
  key: string;
  value?: string;
  locked?: boolean;
  secret?: boolean;
}

export interface ChecklyRetryStrategy {
  type: "FIXED" | "LINEAR" | "EXPONENTIAL" | "SINGLE_RETRY" | string;
  baseBackoffSeconds?: number;
  maxRetries?: number;
  maxDurationSeconds?: number;
  sameRegion?: boolean;
}

export interface ChecklyCheck {
  id: string;
  name: string;
  checkType: "BROWSER" | "API" | "MULTI_STEP" | "PLAYWRIGHT" | "URL" | "HEARTBEAT" | "TCP" | string;
  activated: boolean;
  muted: boolean;
  frequency: number | null;
  frequencyOffset?: number;
  locations: string[];
  privateLocations?: string[];
  tags: string[];
  groupId: number | null;
  runtimeId: string | null;
  runParallel?: boolean;
  doubleCheck?: boolean;
  retryStrategy?: ChecklyRetryStrategy | null;
  environmentVariables?: ChecklyEnvVar[];
  /** BROWSER / MULTI_STEP: the script itself. */
  script?: string | null;
  scriptPath?: string | null;
  /** PLAYWRIGHT check suites. */
  playwrightConfigPath?: string | null;
  pwProjects?: string[] | null;
  pwTags?: string[] | null;
  codeBundlePath?: string | null;
  cacheHash?: string | null;
  playwrightVersion?: string | null;
  installCommand?: string | null;
  testCommand?: string | null;
  /** API / URL checks. */
  request?: {
    method?: string;
    url?: string;
    headers?: Array<{ key: string; value?: string }>;
    queryParameters?: Array<{ key: string; value?: string }>;
    assertions?: Array<{ source: string; property?: string; comparison: string; target: string | number }>;
    body?: string;
    bodyType?: string;
    followRedirects?: boolean;
    skipSSL?: boolean;
  };
  created_at?: string;
  updated_at?: string | null;
  [extra: string]: unknown;
}

export interface CheckResultSummary {
  id: string;
  checkId?: string;
  name?: string;
  hasFailures: boolean;
  hasErrors: boolean;
  isDegraded?: boolean | null;
  runLocation: string;
  startedAt: string;
  stoppedAt?: string;
  responseTime?: number;
  attempts?: number;
  resultType?: "FINAL" | "ATTEMPT";
  sequenceId?: string | null;
  errorGroupIds?: string[] | null;
}

export interface BrowserLikeResult {
  errors?: string[];
  startTime?: number;
  endTime?: number;
  runtimeVersion?: string;
  jobLog?: Array<{ time: number; msg: string; level: string }> | null;
  jobAssets?: string[] | null;
  playwrightTestTraces?: string[];
  playwrightTestVideos?: string[];
  playwrightTestJsonReportFile?: string;
  pages?: Array<{ url: string }>;
  traceSummary?: Record<string, number>;
}

export interface ApiCheckResultDetail {
  assertions?: Array<{ source: string; comparison: string; target: string | number; property?: string }> | null;
  request?: { method: string; url: string; data?: string; headers?: Record<string, string> };
  response?: { status: number; statusText: string; body?: string; headers?: Record<string, string> | null };
  requestError?: string | null;
}

/**
 * Shape seen live for PLAYWRIGHT results (GET /v1/check-results/{checkId}/{id},
 * 2026-09): a top-level `errors` array of test failures, not a
 * `playwrightCheckResult` object.
 */
export interface PlaywrightResultError {
  error: { message: string; stack?: string | null };
  specId?: string;
  testFile?: string;
  suitePath?: string[];
  testTitle?: string;
  projectName?: string;
}

export interface CheckResult extends CheckResultSummary {
  errors?: Array<PlaywrightResultError | string> | null;
  apiCheckResult?: ApiCheckResultDetail | null;
  browserCheckResult?: BrowserLikeResult | null;
  multiStepCheckResult?: BrowserLikeResult | null;
  playwrightCheckResult?: BrowserLikeResult | null;
  [extra: string]: unknown;
}

export interface CheckResultsPage {
  length?: number;
  entries: CheckResultSummary[];
  nextId: string | null;
}

export type AssetType = "log" | "trace" | "video" | "screenshot" | "pcap" | "report" | "file";

export interface AssetManifestEntry {
  type: AssetType;
  name: string;
  url: string;
  contentType?: string;
  source: string;
  archive?: { entryName: string };
}

export interface AssetManifest {
  assets: AssetManifestEntry[];
  truncated?: boolean;
  entriesReturned?: number;
  entriesTotal?: number;
}

export interface RcaEvidence {
  artifacts: Array<{ name: string; type: string }>;
  description: string;
}

export interface RootCauseAnalysis {
  id: string;
  created_at: string;
  analysis: {
    classification: string;
    rootCause: string;
    userImpact: string;
    codeFix: string | null;
    evidence: RcaEvidence[] | null;
    referenceLinks: Array<{ url: string; title: string }> | null;
    /** seen live: Rocky's own repair verdict, e.g. "DO_NOT_REPAIR" */
    repairRecommendation?: string | null;
    /** seen live: the steps Rocky reconstructed, each with the errors it saw */
    steps?: Array<{ name: string; errors?: string[] }> | null;
  };
  provider: string;
  model: string;
  durationMs: number;
  userContext?: Array<{ text: string; type: string }> | null;
}

export interface ErrorGroup {
  id: string;
  checkId: string;
  errorHash: string;
  rawErrorMessage: string | null;
  cleanedErrorMessage: string;
  firstSeen: string;
  lastSeen: string;
  archivedUntilNextEvent?: boolean;
  rootCauseAnalyses?: RootCauseAnalysis[];
}
