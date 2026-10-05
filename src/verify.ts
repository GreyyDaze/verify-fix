// Orchestrator: bundle + patch → contract → scenes → mutants → adequacy →
// decision → report/exit. Single entry for the CLI and the seeded suite.
//
// The patch may change the check code, the check config, or both. Code is
// judged by the contract engine and the scenes; config by the config policy
// (src/scene/config-diff.ts) and by the concurrency the scenes run at.

import { createHash } from "node:crypto";
import type { Bundle, BundleConfig, Decision, ExecutionCost, ExperimentExecutor, RunContext, Scene, SceneObservation } from "./types.ts";
import { buildContract, type ContractReport } from "./contract/contract.ts";
import { assessAdequacy, type MutantResult } from "./adequacy/adequacy.ts";
import { decide } from "./decision/decision.ts";
import { seedMutants } from "./mutation.ts";
import { buildReport, type Report } from "./report/report.ts";
import { detectEnvScopeDodge, regionalUserKeys, SceneExecutor } from "./executor/scene.ts";
import { HybridExecutor } from "./executor/hybrid.ts";
import { inlinePatch, newFiles, originalConfigSource, patchedAssets, patchedCheckSource, patchedConfig, patchedConfigSource, patchedFiles, type PatchSet } from "./patch.ts";
import { applyConfigPolicy, diffCheckConfig, parseCheckConfig, type ConfigPolicy } from "./scene/config-diff.ts";
import { checkEnv, type EnvCheck } from "./scene/env.ts";
import type { CandidateRevisionMetadata, CandidateTargetBinding } from "./candidate/revision.ts";
import { evaluateApiPolicy, type ApiPolicyResult } from "./api/policy.ts";
import { parseApiCheckProject } from "./api/model.ts";
import { evaluateMultiStepPolicy, type MultiStepPolicyResult } from "./multistep/policy.ts";
import { parseMultiStepProject } from "./multistep/source.ts";
import { deriveRegionalAccountMapping } from "./multistep/region-account-mapping.ts";
import { effectiveConcurrency, parseMode } from "./scene/modes.ts";
import { multiStepDiskRebound } from "./multistep/rebind.ts";
import { parseInventory, stripComments } from "./assertion/inventory.ts";
import { compareProtectedRequirements, policyKnown, policyUnknown, type CandidateEffectiveRequirements, type ProtectedPolicyEnvelope, type ProtectedRequirementsComparison, type ResolvedPolicyValue } from "./protected-requirements.ts";

export const PR12_HEALTHY_RUNS = 5; // PR-12: ≥5 repeated healthy runs, else flake → UNCERTAIN

export interface VerifyOptions {
  bundle: Bundle;
  /** the candidate: a PatchSet, or check source text (replaces the main check file) */
  patch: PatchSet | string;
  executor?: ExperimentExecutor;
  /** live target for the scene executor (`--target`) */
  target?: string | null;
  /** the check's variables (`--env-file`) */
  env?: Record<string, string>;
  environmentName?: string;
  maxRunsPerScene?: number;
  /** Checkly/Playwright project whose node_modules runs browser specs. */
  projectDir?: string | null;
  browserExecutablePath?: string;
  /** Exact deployment commit associated with the target URL. */
  targetRevision?: string;
  /** Report-only path of the project whose candidate files were loaded. */
  candidateProject?: string | null;
  /** Immutable complete-source identity for local/PR candidate modes. */
  candidateRevision?: CandidateRevisionMetadata | null;
  /** Source-to-deployment binding and protected-gate eligibility. */
  targetBinding?: CandidateTargetBinding | null;
  /** Trusted workflow rollout control. `shadow` is report-only by default. */
  protectedRequirementsMode?: "shadow" | "migration" | "enforce";
  /** Digest pinned by the trusted caller, outside the candidate checkout. */
  protectedRequirementsDigest?: string | null;
  verbose?: boolean;
}

export interface VerifyResult {
  contract: ContractReport;
  observations: Map<string, SceneObservation>;
  mutants: MutantResult[];
  decision: Decision;
  report: Report;
  envDodge: string | null;
  configPolicy: ConfigPolicy;
  apiPolicy: ApiPolicyResult | null;
  multistepPolicy: MultiStepPolicyResult | null;
  envCheck: EnvCheck;
  patchedConfig: BundleConfig | null;
  cost: ExecutionCost;
  protectedRequirements: ProtectedRequirementsAssessment;
}

export interface ProtectedRequirementsAssessment {
  mode: "shadow" | "migration" | "enforce";
  policyVersion: number | null;
  digest: string | null;
  expectedDigestMatched: boolean | null;
  staticVerdict: "PASS" | "FAILED" | "UNCERTAIN";
  reasonCodes: string[];
  changedMetadata: string[];
  originalValues: Record<string, ResolvedPolicyValue>;
  candidateValues: Record<string, ResolvedPolicyValue>;
  trustedConcurrency: number | null;
  measuredConcurrency: number | null;
  requiredRegions: string[] | null;
  executedRegions: string[];
  affectedMonitors: { known: string[]; unresolved: boolean; reason: string | null };
}

function trustedRequirementRegions(envelope: ProtectedPolicyEnvelope | null): string[] | null {
  const value = envelope?.policy.fields.locations?.original;
  if (!value || value.state !== "known" || !Array.isArray(value.value)
    || value.value.some((region) => typeof region !== "string" || !region)) return null;
  return [...new Set(value.value as string[])].sort();
}

function trustedRequirementConcurrency(bundle: Bundle, envelope: ProtectedPolicyEnvelope | null): number | null {
  const reproduction = bundle.scenes.find((scene) => scene.type === "REPRODUCTION");
  const mode = parseMode(reproduction?.mode);
  if (!reproduction || (mode.kind !== "live" && mode.kind !== "live-concurrent")) return null;
  if (mode.kind === "live") return 1;
  const parallel = envelope?.policy.fields.runParallel?.original;
  const locations = trustedRequirementRegions(envelope);
  if (!parallel || parallel.state !== "known" || typeof parallel.value !== "boolean" || !locations?.length) return null;
  const effective = effectiveConcurrency({ runParallel: parallel.value, locations });
  return Math.min(mode.concurrency, effective);
}

function assessAffectedMonitors(
  bundle: Bundle,
  candidateFiles: Record<string, string>,
  candidateCheckFile: string,
): ProtectedRequirementsAssessment["affectedMonitors"] {
  const allPaths = new Set([...Object.keys(bundle.files), ...Object.keys(candidateFiles)]);
  const changedOutsideIncident = [...allPaths].some((path) => path !== bundle.check.file && path !== candidateCheckFile
    && bundle.files[path] !== candidateFiles[path]);
  const incidentIdentity = bundle.check.logicalId || bundle.check.deployedId;
  const known = incidentIdentity ? [incidentIdentity] : [];
  return {
    known,
    unresolved: changedOutsideIncident || candidateCheckFile !== bundle.check.file,
    reason: changedOutsideIncident || candidateCheckFile !== bundle.check.file
      ? "candidate changes project files beyond the incident check; sibling monitor impact is not inventoried"
      : null,
  };
}

function candidateProtectedRequirements(
  envelope: ProtectedPolicyEnvelope,
  bundle: Bundle,
  candidateFiles: Record<string, string>,
  checkFile: string,
  configView: ReturnType<typeof parseCheckConfig>,
  originalConfigView: ReturnType<typeof parseCheckConfig>,
  checkView: ReturnType<typeof parseCheckConfig>,
  originalCheckView: ReturnType<typeof parseCheckConfig>,
): CandidateEffectiveRequirements {
  const original = envelope.policy.fields;
  const fields: Record<string, ResolvedPolicyValue> = Object.fromEntries(
    Object.entries(original).map(([name, field]) => [name, field.original]),
  );
  const configText = bundle.configFile ? candidateFiles[bundle.configFile] ?? "" : "";
  const originalConfigText = bundle.configFile ? bundle.files[bundle.configFile] ?? "" : "";
  const configChanged = configText !== originalConfigText;
  const checkText = candidateFiles[checkFile] ?? "";
  const originalCheckText = bundle.files[checkFile] ?? bundle.checkSource;
  const checkChanged = checkText !== originalCheckText;
  const write = (name: string, value: unknown) => { fields[name] = policyKnown(value as never); };
  const digestTuples = (values: unknown[]) => values.map((value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")).sort();
  const unresolvedIfRemoved = (name: string, before: unknown, after: unknown) => {
    if ((configChanged || checkChanged) && before !== null && after === null) fields[name] = policyUnknown("DYNAMIC_VALUE_UNRESOLVED");
  };

  const effective = <K extends keyof ReturnType<typeof parseCheckConfig>>(key: K) => checkView[key] ?? configView[key];
  const effectiveBool = (key: "runParallel" | "activated" | "muted" | "shouldFail") => effective(key) as boolean | null;
  const effectiveLocations = (key: "locations" | "privateLocations") => effective(key) as string[] | null;
  const runParallel = effectiveBool("runParallel");
  if (runParallel !== null) write("runParallel", runParallel);
  else unresolvedIfRemoved("runParallel", originalCheckView.runParallel ?? originalConfigView.runParallel, null);
  const locations = effectiveLocations("locations");
  if (locations !== null) write("locations", [...locations].sort());
  else unresolvedIfRemoved("locations", originalCheckView.locations ?? originalConfigView.locations, null);
  const privateLocations = effectiveLocations("privateLocations");
  if (privateLocations !== null) write("privateLocations", [...privateLocations].sort());
  else unresolvedIfRemoved("privateLocations", originalCheckView.privateLocations ?? originalConfigView.privateLocations, null);
  for (const key of ["activated", "muted", "shouldFail"] as const) {
    const value = effectiveBool(key);
    if (value !== null) write(key, value);
    else unresolvedIfRemoved(key, originalCheckView[key] ?? originalConfigView[key], null);
  }
  const frequency = effective("frequency") as string | null;
  if (frequency !== null) {
    const everyMinutes = /(?:EVERY_)?(\d+)M\b/.exec(frequency);
    const everyHours = /(?:EVERY_)?(\d+)H\b/.exec(frequency);
    write("frequency", everyMinutes ? Number(everyMinutes[1]) : everyHours ? Number(everyHours[1]) * 60 : frequency);
  } else unresolvedIfRemoved("frequency", originalCheckView.frequency ?? originalConfigView.frequency, null);
  const envText = `${configText}\n${checkText}`;
  if (/\benvironmentVariables\s*:/.test(envText)) write("environmentVariableNames", [...new Set([...configView.envKeys, ...checkView.envKeys])].sort());
  else if (configChanged && /\benvironmentVariables\s*:/.test(originalConfigText)) fields.environmentVariableNames = policyUnknown("DYNAMIC_VALUE_UNRESOLVED");

  const executableCandidate = Object.entries(candidateFiles)
    .filter(([path]) => /\.[cm]?[jt]sx?$/.test(path))
    .map(([, source]) => stripComments(source)).join("\n");
  let candidateTargetResolution = "unknown";
  if (bundle.check.checkType === "API") {
    const api = parseApiCheckProject(checkFile, new Map(Object.entries(candidateFiles)), bundle.check.logicalId);
    if (api?.request.url.includes("{{ENVIRONMENT_URL}}") || api?.request.url.includes("{{ ENVIRONMENT_URL }}")) candidateTargetResolution = "handlebars";
    else if (/\bENVIRONMENT_URL\b/.test(api?.request.url ?? "") || /\bENVIRONMENT_URL\b/.test(executableCandidate)) candidateTargetResolution = "code";
  } else if (/\bENVIRONMENT_URL\b/.test(executableCandidate)) candidateTargetResolution = "code";
  write("targetResolution", candidateTargetResolution);

  const runtimeId = checkView.runtimeId ?? configView.runtimeId;
  if (bundle.check.checkType === "BROWSER") {
    if (runtimeId !== null) write("browser.runtime", runtimeId);
    else if ((checkChanged || configChanged) && /\bruntimeId\s*:/.test(`${originalConfigText}\n${originalCheckText}`)) {
      fields["browser.runtime"] = policyUnknown("DYNAMIC_VALUE_UNRESOLVED");
    }
  } else if (bundle.check.checkType === "MULTI_STEP") {
    if (runtimeId !== null) write("multistep.runtime", runtimeId);
    else if ((checkChanged || configChanged) && /\bruntimeId\s*:/.test(`${originalConfigText}\n${originalCheckText}`)) {
      fields["multistep.runtime"] = policyUnknown("DYNAMIC_VALUE_UNRESOLVED");
    }
  }

  const alertSettingNames = ["alertChannels", "alertEscalationPolicy", "alertSettings", "useGlobalAlertSettings"];
  if ((checkChanged || configChanged) && alertSettingNames.some((name) =>
    new RegExp(`\\b${name}\\s*:`).test(`${originalConfigText}\n${originalCheckText}\n${configText}\n${checkText}`))) {
    fields.alertBehavior = policyUnknown("DYNAMIC_VALUE_UNRESOLVED");
  }

  const dependencyRequirement = original["execution.dependencyMetadata"]?.original;
  if (dependencyRequirement?.state === "known" && dependencyRequirement.value
    && !Array.isArray(dependencyRequirement.value) && typeof dependencyRequirement.value === "object") {
    const expected = dependencyRequirement.value as Record<string, unknown>;
    const metadataPath = /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|(?:tsconfig|jsconfig)(?:\.[^.]+)*\.json)$/;
    const candidatePaths = Object.keys(candidateFiles).filter((path) => metadataPath.test(path));
    const expectedPaths = Object.keys(expected);
    const samePathSet = candidatePaths.length === expectedPaths.length
      && expectedPaths.every((path) => candidatePaths.includes(path));
    const unchanged = samePathSet && expectedPaths.every((path) => {
      const source = candidateFiles[path];
      return typeof expected[path] === "string" && typeof source === "string"
        && createHash("sha256").update(source, "utf8").digest("hex") === expected[path];
    });
    fields["execution.dependencyMetadata"] = unchanged
      ? policyKnown(expected as never)
      : policyUnknown(samePathSet ? "DYNAMIC_VALUE_UNRESOLVED" : "SOURCE_UNAVAILABLE");
  } else fields["execution.dependencyMetadata"] = policyUnknown("SOURCE_UNAVAILABLE");

  // Check construct identity is source-derived. Unknown/dynamic identity is
  // not replaced with a candidate-controlled policy identity.
  const map = new Map(Object.entries(candidateFiles));
  let logicalId = bundle.check.logicalId || null;
  let identityResolved = true;
  if (bundle.check.checkType === "MULTI_STEP") {
    const source = parseMultiStepProject(map, checkFile);
    if (source?.construct?.logicalId) logicalId = source.construct.logicalId;
    else identityResolved = false;
    const complete = Boolean(source?.script && source.errors.length === 0 && source.construct && source.construct.errors.length === 0);
    if (complete) {
      write("multistep.orderedSteps", source!.script!.steps.map((step) => createHash("sha256").update(step.title).digest("hex")));
      write("multistep.routesAndMethods", source!.script!.requests.map((request) => [request.method, request.route ? createHash("sha256").update(request.route).digest("hex") : null]));
      write("multistep.assertions", digestTuples(source!.script!.assertions.map((assertion) => [assertion.stepTitle, assertion.id, assertion.matcher, assertion.target, assertion.negated])));
      const originalLocationValue = original.locations?.original;
      const trustedLocations = originalLocationValue?.state === "known" && Array.isArray(originalLocationValue.value)
        ? originalLocationValue.value.filter((value): value is string => typeof value === "string")
        : bundle.config?.locations ?? source!.construct!.locations;
      const declaredAccountKeys = [...new Set([
        ...configView.envKeys,
        ...checkView.envKeys,
        ...(source!.construct?.environmentKeys ?? []),
      ])];
      const accountMapping = deriveRegionalAccountMapping(map.entries(), trustedLocations, declaredAccountKeys);
      if (accountMapping) write("multistep.environmentMapping", accountMapping);
      else fields["multistep.environmentMapping"] = policyUnknown("DYNAMIC_VALUE_UNRESOLVED");
      write("multistep.runtimeTransaction", {
        steps: source!.script!.steps.map((step) => createHash("sha256").update(step.title).digest("hex")),
        requests: source!.script!.requests.map((request) => [request.method, request.route ? createHash("sha256").update(request.route).digest("hex") : null]),
      });
    } else {
      for (const name of ["multistep.orderedSteps", "multistep.routesAndMethods", "multistep.assertions", "multistep.environmentMapping", "multistep.runtimeTransaction"]) {
        fields[name] = policyUnknown("DYNAMIC_VALUE_UNRESOLVED");
      }
    }
  } else if (bundle.check.checkType === "API") {
    const api = parseApiCheckProject(checkFile, map, bundle.check.logicalId);
    if (api?.logicalId) logicalId = api.logicalId;
    else identityResolved = false;
    if (api && api.errors.length === 0) {
      write("api.requestMethod", api.request.method.toUpperCase());
      write("api.urlStructure", createHash("sha256").update(api.request.url).digest("hex"));
      write("api.assertions", digestTuples(api.request.assertions.map((assertion) => [assertion.property, assertion.selector, assertion.operator, assertion.target])));
      const setup = api.setupFile ? map.get(api.setupFile) : null;
      const teardown = api.teardownFile ? map.get(api.teardownFile) : null;
      write("api.setupScript", setup === undefined ? null : setup === null ? null : createHash("sha256").update(setup).digest("hex"));
      write("api.tearDownScript", teardown === undefined ? null : teardown === null ? null : createHash("sha256").update(teardown).digest("hex"));
    } else {
      for (const name of ["api.requestMethod", "api.urlStructure", "api.assertions", "api.setupScript", "api.tearDownScript"]) fields[name] = policyUnknown("DYNAMIC_VALUE_UNRESOLVED");
    }
  } else if (bundle.check.checkType === "BROWSER") {
    const source = candidateFiles[checkFile];
    if (source !== undefined) {
      write("browser.entrypoint", checkFile);
      write("browser.assertions", digestTuples(parseInventory(checkFile, source).assertions.map((assertion) => [assertion.subject, assertion.matcher, assertion.target, assertion.negated ?? false])));
      const code = Object.values(candidateFiles).map(stripComments).join("\n");
      write("browser.target", /\bENVIRONMENT_URL\b/.test(code) ? "code" : "unknown");
    } else {
      for (const name of ["browser.entrypoint", "browser.assertions", "browser.target"]) fields[name] = policyUnknown("SOURCE_UNAVAILABLE");
    }
  } else if (bundle.check.checkType === "PLAYWRIGHT") {
    const configPath = bundle.playwright?.configFile;
    const configText = configPath ? candidateFiles[configPath] : undefined;
    if (configPath && configText === undefined) {
      for (const name of ["playwright.configPath", "playwright.projects", "playwright.tags", "playwright.testSelection", "playwright.retries", "playwright.target", "playwright.runtime"]) fields[name] = policyUnknown("SOURCE_UNAVAILABLE");
    } else if (configPath && configText !== undefined && bundle.files[configPath] !== configText) {
      // Candidate Playwright config can affect test selection, retries and
      // baseURL. Until the full Playwright config AST is resolved, changed
      // executable settings remain uncertain rather than inheriting trust.
      for (const name of ["playwright.testSelection", "playwright.retries", "playwright.target"]) fields[name] = policyUnknown("DYNAMIC_VALUE_UNRESOLVED");
    }
  }
  // Fields not rewritten by the candidate resolver still inherit the
  // trusted effective value. This is required for unchanged inherited/default
  // settings such as alert behavior and dependency metadata. A changed setting
  // is explicitly written as known or unknown above; it is never silently
  // replaced here.
  for (const [name, requirement] of Object.entries(original)) {
    if (!(name in fields)) fields[name] = requirement.original;
  }
  return {
    check: {
      id: bundle.check.deployedId ?? "",
      logicalId,
      checkType: bundle.check.checkType ?? "",
    },
    fields,
    identityResolved: identityResolved && bundle.check.deployedId !== null && bundle.check.checkType !== undefined,
  };
}

export function makeExecutor(opts: { target?: string | null; targetRevision?: string; env?: Record<string, string>; environmentName?: string; maxRunsPerScene?: number; projectDir?: string | null; browserExecutablePath?: string; verbose?: boolean }): ExperimentExecutor {
  if (process.env.VERIFY_FIX_EXECUTOR === "hybrid") {
    return new HybridExecutor({ target: opts.target ?? null, targetRevision: opts.targetRevision, env: opts.env, environmentName: opts.environmentName, maxRunsPerScene: opts.maxRunsPerScene, projectDir: opts.projectDir, browserExecutablePath: opts.browserExecutablePath, verbose: opts.verbose });
  }
  return new SceneExecutor({ target: opts.target ?? null, env: opts.env, environmentName: opts.environmentName, maxRunsPerScene: opts.maxRunsPerScene, projectDir: opts.projectDir, browserExecutablePath: opts.browserExecutablePath, verbose: opts.verbose });
}

export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const verifyStartedAt = Date.now();
  const { bundle, verbose } = opts;
  const diskBound = bundle.schemaVersion !== "v3" || bundle.check.checkType !== "MULTI_STEP"
    || multiStepDiskRebound(bundle);
  const patch: PatchSet = typeof opts.patch === "string" ? inlinePatch(bundle, opts.patch) : opts.patch;
  const patchSource = patchedCheckSource(bundle, patch);
  const executor = opts.executor ?? makeExecutor({ target: opts.target, targetRevision: opts.targetRevision, env: opts.env, environmentName: opts.environmentName, maxRunsPerScene: opts.maxRunsPerScene, projectDir: opts.projectDir, browserExecutablePath: opts.browserExecutablePath, verbose });

  // ── static: code dodges, config policy, environment ──────────────────────
  const originalCfg = parseCheckConfig(originalConfigSource(bundle));
  const patchedCfgView = parseCheckConfig(patchedConfigSource(bundle, patch));
  const codeChanged = patchSource !== bundle.checkSource;
  const configPolicy = applyConfigPolicy(diffCheckConfig(originalCfg, patchedCfgView), codeChanged, originalCfg, patchedCfgView);
  const runConfig = patchedConfig(bundle, patch);
  const candidateFiles = patchedFiles(bundle, patch);
  const candidateCheckFile = patch.checkFile ?? bundle.check.file;
  const originalFiles = new Map(Object.entries(bundle.files));
  originalFiles.set(bundle.check.file, bundle.checkSource);
  const candidateFileMap = new Map(Object.entries(candidateFiles));
  candidateFileMap.set(candidateCheckFile, patchSource);
  const protectedMode = opts.protectedRequirementsMode ?? "shadow";
  const protectedEnvelope = bundle.protectedRequirements ?? null;
  const affectedMonitors = assessAffectedMonitors(bundle, candidateFiles, candidateCheckFile);
  const expectedPolicyDigest = opts.protectedRequirementsDigest ?? null;
  const expectedDigestMatched = expectedPolicyDigest === null
    ? null
    : protectedEnvelope !== null && /^[a-f0-9]{64}$/.test(expectedPolicyDigest)
      && protectedEnvelope.sha256 === expectedPolicyDigest;
  let protectedComparison: ProtectedRequirementsComparison | null = null;
  let protectedCandidate: CandidateEffectiveRequirements | null = null;
  let protectedReasonCodes: string[] = [];
  if (protectedEnvelope) {
    protectedCandidate = candidateProtectedRequirements(
      protectedEnvelope, bundle, candidateFiles, candidateCheckFile, patchedCfgView, originalCfg,
      parseCheckConfig(patchSource), parseCheckConfig(bundle.checkSource),
    );
    protectedComparison = compareProtectedRequirements(protectedEnvelope, protectedCandidate);
    protectedReasonCodes = [...protectedComparison.reasonCodes];
    if (affectedMonitors.unresolved) {
      // The bundle currently has no complete sibling-monitor inventory. Any
      // project-level change can affect checks outside this incident, so do
      // not claim regression safety until the impact is enumerated and run.
      protectedReasonCodes.push("PROTECTED_REGRESSION_SCOPE_UNRESOLVED");
    }
  } else {
    protectedReasonCodes = [bundle.protectedRequirementsIssue ?? "PROTECTED_POLICY_MISSING"];
  }
  if ((protectedMode === "enforce" || protectedMode === "migration") && !protectedEnvelope) {
    protectedReasonCodes = [...new Set([...protectedReasonCodes, bundle.protectedRequirementsIssue ?? "PROTECTED_POLICY_MISSING"])];
  }
  if ((protectedMode === "enforce" || protectedMode === "migration") && !expectedPolicyDigest) {
    protectedReasonCodes = [...new Set([...protectedReasonCodes, "PROTECTED_POLICY_PIN_MISSING"])];
  } else if (expectedPolicyDigest && expectedDigestMatched !== true) {
    protectedReasonCodes = [...new Set([...protectedReasonCodes, "PROTECTED_POLICY_PIN_MISMATCH"])];
  }
  const checkSourceMaskingChanges = diffCheckConfig(parseCheckConfig(bundle.checkSource), parseCheckConfig(patchSource)).some((change) => change.family === "masking");
  if (protectedMode === "enforce" && (configPolicy.changes.some((change) => change.family === "masking") || checkSourceMaskingChanges)) {
    protectedReasonCodes = [...new Set([...protectedReasonCodes, "PROTECTED_MASKING_SETTING_CHANGED"])];
  }
  const protectedStaticVerdict: ProtectedRequirementsAssessment["staticVerdict"] =
    protectedReasonCodes.includes("PROTECTED_REQUIREMENT_CHANGED") || protectedReasonCodes.includes("PROTECTED_CHECK_IDENTITY_CHANGED") || protectedReasonCodes.includes("PROTECTED_MASKING_SETTING_CHANGED")
      ? "FAILED"
      : protectedReasonCodes.length || protectedComparison?.verdict === "UNCERTAIN" || !protectedComparison
        ? "UNCERTAIN" : "PASS";
  const protectedAssessment: ProtectedRequirementsAssessment = {
    mode: protectedMode,
    policyVersion: protectedEnvelope?.policy.policyVersion ?? null,
    digest: protectedEnvelope?.sha256 ?? null,
    expectedDigestMatched,
    staticVerdict: protectedStaticVerdict,
    reasonCodes: protectedReasonCodes,
    changedMetadata: protectedComparison?.changedMetadata ?? [],
    originalValues: protectedEnvelope ? Object.fromEntries(Object.entries(protectedEnvelope.policy.fields).map(([name, field]) => [name, field.original])) : {},
    candidateValues: protectedCandidate?.fields ?? {},
    trustedConcurrency: trustedRequirementConcurrency(bundle, protectedEnvelope),
    measuredConcurrency: null,
    requiredRegions: trustedRequirementRegions(protectedEnvelope),
    executedRegions: [],
    affectedMonitors,
  };
  const protectedGateRejected = protectedMode === "enforce" && protectedStaticVerdict === "FAILED"
    ? `protected requirements changed (${protectedReasonCodes.join(", ")})` : null;
  const protectedGateUncertain = protectedMode === "enforce" && protectedStaticVerdict === "UNCERTAIN"
    ? `protected requirements unresolved (${protectedReasonCodes.join(", ")})` : null;
  const apiPolicy = bundle.check.checkType === "API" || bundle.api
    ? evaluateApiPolicy(bundle.check.file, originalFiles, candidateCheckFile, candidateFileMap, bundle.check.logicalId)
    : null;
  // Multistep static policy: same evidence→verdict path as the API policy
  // (rejected → FAILED, uncertain → UNCERTAIN through the existing law).
  const isMultiStep = bundle.check.checkType === "MULTI_STEP" ||
    [...originalFiles.values()].some((source) => source.includes("new MultiStepCheck("));
  const multistepPolicy = isMultiStep
    ? evaluateMultiStepPolicy(parseMultiStepProject(originalFiles, bundle.check.file), parseMultiStepProject(candidateFileMap, candidateCheckFile))
    : null;
  const declared = [...new Set([
    ...(bundle.config?.environmentVariables ?? []),
    ...(runConfig?.environmentVariables ?? []),
    ...configPolicy.declaredEnvKeys,
    ...(apiPolicy?.candidate?.environmentKeys ?? []),
  ])];
  let envDodge = detectEnvScopeDodge(bundle.checkSource, patchSource, { locations: bundle.config?.locations ?? runConfig?.locations, declaredEnvKeys: declared });
  if (isMultiStep && envDodge) envDodge = "regional account data flow changed or generated at runtime — trusted per-location mapping not proven";
  const provided = { ...(opts.env ?? {}) };
  // The Checkly construct reads its approved CHECKLY_SECRET_* input and injects
  // the protected-target bypass as a check variable. Mark availability only;
  // never copy the secret value into verification diagnostics or evidence.
  if (isMultiStep && provided.CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET) {
    provided.VERCEL_AUTOMATION_BYPASS_SECRET = "available-via-approved-checkly-binding";
  }
  const regionalKeys = regionalUserKeys(patchSource, { locations: bundle.config?.locations ?? runConfig?.locations, declaredEnvKeys: declared });
  if (!envDodge && regionalKeys) {
    const values = regionalKeys.map((key) => provided[key]).filter((value): value is string => Boolean(value));
    if (values.length === regionalKeys.length && new Set(values).size !== values.length) {
      envDodge = "regional test-user variables resolve to the same value — overlapping locations still share one account";
    }
  }
  const ctx: RunContext = {
    // Candidate-independent experiment conditions: candidate scheduling
    // cannot lower the trusted regions or overlap used by the scenes.
    config: bundle.config,
    files: candidateFiles,
    assets: patchedAssets(patch),
    ...(patch.checkFile ? { checkFile: patch.checkFile } : {}),
    ...(patch.playwrightConfigFile ? { playwrightConfigFile: patch.playwrightConfigFile } : {}),
    ...(patch.checkName ? { checkName: patch.checkName } : {}),
    phase: "candidate",
  };
  const environmentEntries = apiPolicy
    ? [candidateCheckFile, apiPolicy.candidate?.setupFile, apiPolicy.candidate?.teardownFile]
        .filter((file): file is string => Boolean(file))
        .map((file) => [file, candidateFiles[file]] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string")
    : [[candidateCheckFile, patchSource] as const];
  const environmentSource = environmentEntries.map(([file, source]) => `// ${file}\n${source}`).join("\n");
  const envCheck = checkEnv(environmentSource || patchSource, provided, declared, isMultiStep ? ["REGION"] : []);
  const added = newFiles(bundle, patch);

  const contract = buildContract(bundle, patchSource, candidateFileMap, candidateCheckFile);
  if (!diskBound) contract.provenanceViolations.push("MULTISTEP_DISK_BINDING_INVALID");
  if (verbose) {
    console.error(`[verify] ${bundle.incidentId}: ${bundle.scenes.length} scenes, determinism gate blocked=${contract.determinismGate.blocked}, config changes=${configPolicy.changes.length}, env missing=${envCheck.missing.map((m) => m.name).join(",") || "none"}`);
  }

  const observations = new Map<string, SceneObservation>();
  // Unsupported Multistep source is a pre-execution UNCERTAIN gate. A child
  // must never run first and only *then* have its result changed to UNCERTAIN.
  const missingEnvReason = protectedGateUncertain ?? (!diskBound ? "MULTISTEP_DISK_BINDING_INVALID" : null) ?? multistepPolicy?.uncertain
    ?? apiPolicy?.uncertain
    ?? (apiPolicy && !opts.target ? "ENVIRONMENT_URL is missing; pass --target so {{ENVIRONMENT_URL}} can be resolved without a fallback" : null)
    ?? (envCheck.missing.length > 0
      ? isMultiStep
        ? "Multistep environment values are missing — pass --env-file; a run with empty variables would not be the original check"
        : `the check reads ${envCheck.missing.map((m) => `${m.form === "handlebars" ? "{{" + m.name + "}}" : "process.env." + m.name} (line ${m.line})`).join(", ")} and no value was provided — pass --env-file; a run with an empty variable would not be the customer's check`
      : null)
    ?? (bundle.multistep?.problems && bundle.multistep.problems.length > 0
      ? `multistep evidence unresolved: ${bundle.multistep.problems.join("; ")}`
      : null);
  const undeclaredEnvReason = envCheck.undeclared.length > 0
    ? isMultiStep ? "Multistep patch reads undeclared environment variable(s)" : `the patch reads undeclared environment variable(s): ${envCheck.undeclared.join(", ")}`
    : null;
  const preflightRejected = protectedGateRejected ?? patch.rejection ?? apiPolicy?.rejected ?? multistepPolicy?.rejected ?? staticallyRejected(bundle, patchSource, candidateFileMap, candidateCheckFile) ?? envDodge ?? configPolicy.rejected ?? undeclaredEnvReason;
  if (preflightRejected) {
    if (verbose) console.error(`[verify] static rejection before execution: ${preflightRejected}`);
  } else if (missingEnvReason) {
    for (const s of bundle.scenes) {
      observations.set(s.sceneId, { sceneId: s.sceneId, observed: "uncertain", repetitions: 0, trace: [], source: s.type === "HEALTHY" || s.type === "REGRESSION" ? "checkly" : "scene", reason: missingEnvReason, environment: s.environment ?? "target" });
    }
  } else {
    const rank: Record<Scene["type"], number> = { REPRODUCTION: 0, DETECTION: 1, HEALTHY: 2, REGRESSION: 3, MUTATION: 4 };
    const ordered = [...bundle.scenes].sort((a, b) => rank[a.type] - rank[b.type]);
    for (const s of ordered) {
      const observation = await executor.runScene(bundle, patchSource, s, ctx);
      observations.set(s.sceneId, observation);
      const expected = s.verdict.mustFail ? "fail" : "pass";
      // A conclusive mismatch already fixes the verdict at FAILED. Missing
      // evidence already fixes it at UNCERTAIN. Do not buy later cloud runs.
      if (observation.observed === "uncertain" || observation.observed !== expected) break;
    }
  }
  // Determinism evidence is about the CANDIDATE's own repetitions; snapshot it
  // before the mutation phase runs weakened variants through the same executor.
  const nonDet = [...new Set(executor.nondeterministicScenes)];

  // Mutation phase: few, directed weak variants of the CANDIDATE patch.
  // Killed = the verifier caught it: either the contract engine rejects the
  // mutant outright (a core-path assertion removed/weakened, or an assertion
  // wrapped so its failure is swallowed — the same static law that FAILs a
  // candidate), or the scenes distinguish it (detection switched to pass, or
  // healthy broke). Survived = the verifier would give the mutant the same
  // verdict as the candidate — it cannot see the piece the mutant removed →
  // blind-spot signal. An `uncertain` observation is no evidence either way,
  // so it never counts as a catch.
  const mutantResults: MutantResult[] = [];
  const detectionScene = bundle.scenes.find((s) => s.type === "DETECTION");
  const healthyScene = bundle.scenes.find((s) => s.type === "HEALTHY");
  const candidateScenesMatched = bundle.scenes.every((s) => {
    const observed = observations.get(s.sceneId)?.observed;
    return observed !== undefined && observed !== "uncertain" && observed === (s.verdict.mustFail ? "fail" : "pass");
  });
  const mutationCtx: RunContext = { ...ctx, phase: "mutation" };
  for (const m of candidateScenesMatched ? seedMutants(patchSource, candidateCheckFile, candidateFiles) : []) {
    const mutantFiles = new Map(candidateFileMap);
    mutantFiles.set(candidateCheckFile, m.source);
    const staticKill = staticallyRejected(bundle, m.source, mutantFiles, candidateCheckFile);
    let detObs: SceneObservation | null = null;
    let healthyObs: SceneObservation | null = null;
    let survived: boolean;
    let inconclusive = false;
    if (staticKill) {
      survived = false;
    } else if (missingEnvReason) {
      survived = true; // nothing could be observed; the verifier cannot claim a catch
    } else {
      detObs = detectionScene ? await executor.runScene(bundle, m.source, detectionScene, mutationCtx) : null;
      const detCaught = detObs?.observed === "pass"; // masked a must-fail → caught
      // A detection kill is conclusive. Avoid a paid remote healthy run.
      healthyObs = !detCaught && healthyScene ? await executor.runScene(bundle, m.source, healthyScene, mutationCtx) : null;
      const healthyCaught = healthyObs?.observed === "fail"; // broke healthy → caught
      // A budget, timeout, missing report or unavailable runner is not a
      // mutant kill and is not proof the mutant survived either. Only two
      // admitted observations (or a conclusive kill) can decide it.
      inconclusive = !detCaught && !healthyCaught
        && (detObs?.observed == null || healthyObs?.observed == null
          || detObs.observed === "uncertain" || healthyObs.observed === "uncertain");
      survived = !inconclusive && !(detCaught || healthyCaught);
    }
    mutantResults.push({ name: m.name, family: m.family, survived, ...(inconclusive ? { inconclusive: true } : {}), detail: m.detail });
    if (verbose) {
      const how = staticKill ? `static: ${staticKill}` : `det="${detObs?.observed ?? "n/a"}", healthy="${healthyObs?.observed ?? "n/a"}"`;
      console.error(`[verify] mutant ${m.name} (${m.family}) outcome=${inconclusive ? "inconclusive" : survived ? "survived" : "killed"} (${how})`);
    }
  }
  const healthySceneIds = bundle.scenes.filter((s) => s.type === "HEALTHY").map((s) => s.sceneId);
  const healthyRuns = healthySceneIds.map((id) => observations.get(id)?.repetitions ?? 0);
  const healthyRepetitionsMet = healthySceneIds.length > 0 && healthyRuns.every((r) => r >= PR12_HEALTHY_RUNS);

  const adequacy = assessAdequacy({ contract, sceneObservations: observations, mutants: mutantResults });

  if (diskBound && bundle.schemaVersion === "v3" && bundle.check.checkType === "MULTI_STEP"
    && !multiStepDiskRebound(bundle)) contract.provenanceViolations.push("MULTISTEP_DISK_BINDING_INVALID");
  const decision = decide({
    contract,
    observations,
    adequacy,
    nonDeterministicScenes: nonDet,
    healthyRepetitionsMet,
    runBudgetExhausted: executor.budgetExhausted || false,
  });

  // ── static rejections outrank observations only for admitted bundles ────
  // A removed incident check, dodge, or masking-only config change is a
  // definite finding, not missing evidence: FAILED even when scenes did not run.
  if (!contract.provenanceViolations.length && patch.rejection) {
    decision.reasons.push(`candidate identity: ${patch.rejection}`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  if (!contract.provenanceViolations.length && envDodge) {
    decision.reasons.push(`env-scope dodge detected: ${envDodge}`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  if (!contract.provenanceViolations.length && configPolicy.rejected) {
    decision.reasons.push(`config policy: ${configPolicy.rejected}`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  if (!contract.provenanceViolations.length && apiPolicy?.rejected) {
    decision.reasons.push(`API policy: ${apiPolicy.rejected}`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  if (!contract.provenanceViolations.length && multistepPolicy?.rejected) {
    decision.reasons.push(`multistep policy: ${multistepPolicy.rejected}`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  for (const n of configPolicy.notes) decision.reasons.push(`config: ${n}`);
  for (const n of apiPolicy?.notes ?? []) decision.reasons.push(`API: ${n}`);
  for (const n of multistepPolicy?.notes ?? []) decision.reasons.push(`multistep: ${n}`);
  if (!contract.provenanceViolations.length && apiPolicy?.uncertain && !patch.rejection && !envDodge && !configPolicy.rejected && !apiPolicy.rejected && !multistepPolicy?.rejected) {
    decision.reasons.push(`API evidence unresolved: ${apiPolicy.uncertain}`);
    decision.verdict = "UNCERTAIN";
    decision.exitCode = 2;
  }
  if (!contract.provenanceViolations.length && multistepPolicy?.uncertain && !patch.rejection && !envDodge && !configPolicy.rejected && !apiPolicy?.rejected && !multistepPolicy.rejected) {
    decision.reasons.push(`multistep source unresolved: ${multistepPolicy.uncertain}`);
    decision.verdict = "UNCERTAIN";
    decision.exitCode = 2;
  }
  if (!contract.provenanceViolations.length && envCheck.undeclared.length > 0) {
    decision.reasons.push(isMultiStep
      ? "env: Multistep patch reads undeclared environment variables — the check's declared variable names must be preserved"
      : `env: the patch reads ${envCheck.undeclared.join(", ")} — not declared on the check; it must be added to the check's environment variables in Checkly (values never enter the bundle)`);
    decision.verdict = "FAILED";
    decision.exitCode = 1;
  }
  for (const d of envCheck.defaulted) decision.reasons.push(isMultiStep
    ? "env: Multistep environment value defaulted — untrusted fallback cannot prove the configured check"
    : `env: ${d.name} not provided; the check ran on its own fallback (line ${d.line})`);
  if (added.length > 0) decision.reasons.push(isMultiStep
    ? `Multistep patch adds ${added.length} file(s) not in the bundle (candidate check tree expanded)`
    : `patch adds files not in the bundle: ${added.join(", ")} (copied into the candidate check tree)`);

  if (protectedMode === "enforce") {
    if (protectedStaticVerdict === "FAILED") {
      decision.reasons.push(`protected requirements: ${protectedReasonCodes.join(", ")}`);
      decision.verdict = "FAILED";
      decision.exitCode = 1;
    } else if (protectedStaticVerdict === "UNCERTAIN" && decision.verdict !== "FAILED") {
      decision.reasons.push(`protected requirements: ${protectedReasonCodes.join(", ")}`);
      decision.verdict = "UNCERTAIN";
      decision.exitCode = 2;
    }
  } else if (protectedMode === "migration" && protectedReasonCodes.length) {
    decision.reasons.push(`protected requirements migration: ${protectedReasonCodes.join(", ")} (report-only)`);
  } else if (protectedMode === "shadow") {
    decision.reasons.push(`protected requirements shadow: ${protectedStaticVerdict.toLowerCase()}${protectedReasonCodes.length ? ` (${protectedReasonCodes.join(", ")})` : ""}; current verdict unchanged`);
  }

  await executor.close?.();

  const cost = executor.costReport();
  cost.runs = cost.checklyCloudRuns + cost.localRuns;
  cost.wallTimeMs = Date.now() - verifyStartedAt;
  const candidateSceneCosts = cost.byScene.filter((row) => row.phase === "candidate");
  const measuredConcurrency = candidateSceneCosts
    .map((row) => row.maxConcurrentRuns)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  protectedAssessment.measuredConcurrency = measuredConcurrency.length ? Math.max(...measuredConcurrency) : null;
  protectedAssessment.executedRegions = [...new Set(candidateSceneCosts.flatMap((row) => row.executedRegions ?? []))].sort();
  const report = buildReport(contract, decision, observations, {
    cost,
    target: opts.target ?? null,
    targetRevision: opts.targetRevision ?? null,
    candidateProject: opts.candidateProject ?? null,
    candidate: patch.path ?? patch.kind,
    candidateRevision: opts.candidateRevision ?? patch.revision ?? null,
    candidateCheck: patch.checkLogicalId ? { logicalId: patch.checkLogicalId, name: patch.checkName ?? null, file: patch.checkFile ?? null } : null,
    targetBinding: opts.targetBinding ?? null,
    multistep: bundle.multistep
      ? { kind: bundle.multistep.kind, steps: bundle.multistep.steps, problems: bundle.multistep.problems }
      : null,
    protectedRequirements: protectedAssessment,
  });
  return {
    contract,
    observations,
    mutants: mutantResults,
    decision,
    report,
    envDodge,
    configPolicy,
    apiPolicy,
    multistepPolicy,
    envCheck,
    patchedConfig: runConfig,
    cost,
    protectedRequirements: protectedAssessment,
  };
}

/** The contract engine's static law applied to a mutant: returns the reason it
 * would be FAILED before any scene runs, or null if only the scenes can tell. */
export function staticallyRejected(bundle: Bundle, mutantSource: string, files?: Map<string, string>, checkFile?: string): string | null {
  const c = buildContract(bundle, mutantSource, files, checkFile);
  const core = [...c.diff.removed, ...c.diff.weakened].filter((a) => a.onCriticalPath);
  if (core.length > 0) return bundle.check.checkType === "MULTI_STEP"
    ? `core-path assertion removed/weakened (${core.length} assertion tuple(s))`
    : `core-path assertion removed/weakened (${core.map((a) => `${a.subject}.${a.matcher}`).join(", ")})`;
  if (c.suppressionCandidates.length > 0) return `suppression candidate (${c.suppressionCandidates.length})`;
  return null;
}

export function healthyRunsUsed(bundle: Bundle, observations: Map<string, SceneObservation>): number {
  const h = bundle.scenes.filter((s): s is Scene & { type: "HEALTHY" } => s.type === "HEALTHY");
  return h.reduce((acc, s) => acc + (observations.get(s.sceneId)?.repetitions ?? 0), 0);
}
