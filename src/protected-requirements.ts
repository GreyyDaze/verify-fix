import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Phase 9 protected policy primitives. The bundle builder supplies facts from
 * Checkly and statically resolved project sources. Missing/inherited values
 * stay unknown; this layer never invents Checkly defaults.
 */
export const PROTECTED_REQUIREMENTS_VERSION = "protected-requirements-v2" as const;

export type PolicyUnknownReason =
  | "CONFIG_NOT_RETURNED"
  | "DYNAMIC_VALUE_UNRESOLVED"
  | "UNSUPPORTED_SETTING"
  | "SOURCE_UNAVAILABLE";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ResolvedPolicyValue =
  | { state: "known"; value: JsonValue }
  | { state: "unknown"; reason: PolicyUnknownReason };

export type ProtectedComparison = "exact" | "set-equal" | "required-tuples";

export interface ProtectedRequirementField {
  effect: "protected" | "metadata";
  comparison: ProtectedComparison;
  original: ResolvedPolicyValue;
}

export interface ProtectedSourceIdentity {
  kind: "checkly-api" | "project-default" | "check-group" | "check" | "imported-source" | "playwright-config";
  identity: string;
  sha256: string;
}

export interface ProtectedRequirementsPolicy {
  schemaVersion: typeof PROTECTED_REQUIREMENTS_VERSION;
  policyVersion: 2;
  check: { id: string; logicalId: string | null; checkType: string };
  sources: ProtectedSourceIdentity[];
  fields: Record<string, ProtectedRequirementField>;
}

export interface ProtectedRequirementsInput {
  check: ProtectedRequirementsPolicy["check"];
  sources: ProtectedSourceIdentity[];
  /**
   * Values already resolved from trusted Checkly API/config/source evidence.
   * This function never invents Checkly defaults. Omitted required values are
   * stored as unknown and therefore cannot produce PASS.
   */
  values: Record<string, ResolvedPolicyValue>;
  /** Effective setting names seen by the caller that have no adapter yet. */
  unsupportedSettings?: string[];
}

export type ProtectedRequirementsBuildResult =
  | { status: "ready"; envelope: ProtectedPolicyEnvelope; adapter: string }
  | { status: "unsupported"; reasonCode: "UNSUPPORTED_CHECK_TYPE" };

interface RequirementDescriptor {
  name: string;
  effect: ProtectedRequirementField["effect"];
  comparison: ProtectedComparison;
}

const COMMON_REQUIREMENTS: readonly RequirementDescriptor[] = [
  { name: "check.name", effect: "metadata", comparison: "exact" },
  { name: "activated", effect: "protected", comparison: "exact" },
  { name: "muted", effect: "protected", comparison: "exact" },
  { name: "shouldFail", effect: "protected", comparison: "exact" },
  { name: "frequency", effect: "protected", comparison: "exact" },
  { name: "locations", effect: "protected", comparison: "set-equal" },
  { name: "privateLocations", effect: "protected", comparison: "set-equal" },
  { name: "runParallel", effect: "protected", comparison: "exact" },
  { name: "retryStrategy", effect: "protected", comparison: "exact" },
  { name: "alertBehavior", effect: "protected", comparison: "exact" },
  { name: "environmentVariableNames", effect: "protected", comparison: "set-equal" },
  { name: "targetResolution", effect: "protected", comparison: "exact" },
  { name: "execution.dependencyMetadata", effect: "protected", comparison: "exact" },
];

/**
 * Fixed adapters for the supported Checkly resource types. These names are
 * normalized policy fields, not Checkly fixture identifiers. Input values
 * must come from the effective-model resolver; source parsing alone is not
 * sufficient to claim that inheritance has been resolved.
 */
export const PROTECTED_REQUIREMENT_ADAPTERS = {
  API: {
    id: "checkly-api-v1",
    fields: [
      { name: "api.requestMethod", effect: "protected", comparison: "exact" },
      { name: "api.urlStructure", effect: "protected", comparison: "exact" },
      { name: "api.assertions", effect: "protected", comparison: "required-tuples" },
      { name: "api.setupScript", effect: "protected", comparison: "exact" },
      { name: "api.tearDownScript", effect: "protected", comparison: "exact" },
    ],
  },
  BROWSER: {
    id: "checkly-browser-v1",
    fields: [
      { name: "browser.entrypoint", effect: "protected", comparison: "exact" },
      { name: "browser.runtime", effect: "protected", comparison: "exact" },
      { name: "browser.assertions", effect: "protected", comparison: "required-tuples" },
      { name: "browser.target", effect: "protected", comparison: "exact" },
    ],
  },
  PLAYWRIGHT: {
    id: "checkly-playwright-v1",
    fields: [
      { name: "playwright.configPath", effect: "protected", comparison: "exact" },
      { name: "playwright.projects", effect: "protected", comparison: "set-equal" },
      { name: "playwright.tags", effect: "protected", comparison: "set-equal" },
      { name: "playwright.testSelection", effect: "protected", comparison: "exact" },
      { name: "playwright.retries", effect: "protected", comparison: "exact" },
      { name: "playwright.target", effect: "protected", comparison: "exact" },
      { name: "playwright.runtime", effect: "protected", comparison: "exact" },
    ],
  },
  MULTI_STEP: {
    id: "checkly-multistep-v1",
    fields: [
      { name: "multistep.orderedSteps", effect: "protected", comparison: "exact" },
      { name: "multistep.routesAndMethods", effect: "protected", comparison: "exact" },
      { name: "multistep.assertions", effect: "protected", comparison: "required-tuples" },
      { name: "multistep.environmentMapping", effect: "protected", comparison: "exact" },
      { name: "multistep.runtimeTransaction", effect: "protected", comparison: "exact" },
      { name: "multistep.runtime", effect: "protected", comparison: "exact" },
    ],
  },
} as const satisfies Record<string, { id: string; fields: readonly RequirementDescriptor[] }>;

export interface ProtectedPolicyEnvelope {
  policy: ProtectedRequirementsPolicy;
  sha256: string;
}

export interface CandidateEffectiveRequirements {
  check: { id: string; logicalId: string | null; checkType: string };
  fields: Record<string, ResolvedPolicyValue>;
  identityResolved?: boolean;
}

export interface ProtectedRequirementsComparison {
  verdict: "PASS" | "FAILED" | "UNCERTAIN";
  reasonCodes: string[];
  changedMetadata: string[];
}

export function policyKnown(value: JsonValue): ResolvedPolicyValue {
  return { state: "known", value };
}

export function policyUnknown(reason: PolicyUnknownReason): ResolvedPolicyValue {
  return { state: "unknown", reason };
}

export function protectedSourceIdentity(
  kind: ProtectedSourceIdentity["kind"],
  identity: string,
  contents: string | Buffer,
): ProtectedSourceIdentity {
  return { kind, identity, sha256: createHash("sha256").update(contents).digest("hex") };
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, JsonValue>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key]!)}`).join(",")}}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function policyBody(policy: ProtectedRequirementsPolicy): string {
  return canonical(policy as unknown as JsonValue);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => isJsonValue(item, depth + 1));
  if (!isPlainRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 10_000 && entries.every(([key, item]) => key.length <= 256 && isJsonValue(item, depth + 1));
}

/** Build a stable digest over a normalized, secret-free protected policy. */
export function sealProtectedRequirements(policy: ProtectedRequirementsPolicy): ProtectedPolicyEnvelope {
  assertProtectedRequirementsPolicy(policy);
  return { policy, sha256: sha256(policyBody(policy)) };
}

/**
 * Build a versioned, fail-closed policy from normalized effective Checkly
 * facts. Missing facts remain unknown; undocumented defaults are never
 * substituted here. Unknown original settings are preserved as unresolved
 * protected requirements until an adapter classifies their impact.
 */
export function buildProtectedRequirements(input: ProtectedRequirementsInput): ProtectedRequirementsBuildResult {
  const adapter = PROTECTED_REQUIREMENT_ADAPTERS[input.check.checkType as keyof typeof PROTECTED_REQUIREMENT_ADAPTERS];
  if (!adapter) return { status: "unsupported", reasonCode: "UNSUPPORTED_CHECK_TYPE" };

  const fields: Record<string, ProtectedRequirementField> = {};
  for (const descriptor of [...COMMON_REQUIREMENTS, ...adapter.fields]) {
    fields[descriptor.name] = {
      effect: descriptor.effect,
      comparison: descriptor.comparison,
      original: input.values[descriptor.name] ?? { state: "unknown", reason: "CONFIG_NOT_RETURNED" },
    };
  }
  for (const name of new Set(input.unsupportedSettings ?? [])) {
    if (name in fields) continue;
    fields[name] = {
      effect: "protected",
      comparison: "exact",
      original: { state: "unknown", reason: "UNSUPPORTED_SETTING" },
    };
  }

  const policy: ProtectedRequirementsPolicy = {
    schemaVersion: PROTECTED_REQUIREMENTS_VERSION,
    policyVersion: 2,
    check: input.check,
    sources: input.sources,
    fields,
  };
  return { status: "ready", adapter: adapter.id, envelope: sealProtectedRequirements(policy) };
}

/** Validate the versioned shape and its content digest before trusting a policy. */
export function assertProtectedRequirementsPolicy(policy: unknown): asserts policy is ProtectedRequirementsPolicy {
  if (!isPlainRecord(policy) || policy.schemaVersion !== PROTECTED_REQUIREMENTS_VERSION || policy.policyVersion !== 2
    || !isPlainRecord(policy.check) || typeof policy.check.id !== "string" || !policy.check.id
    || !(typeof policy.check.logicalId === "string" || policy.check.logicalId === null)
    || typeof policy.check.checkType !== "string" || !policy.check.checkType
    || !Array.isArray(policy.sources) || policy.sources.length === 0 || !isPlainRecord(policy.fields)) {
    throw new Error("PROTECTED_POLICY_INVALID");
  }
  const adapter = PROTECTED_REQUIREMENT_ADAPTERS[policy.check.checkType as keyof typeof PROTECTED_REQUIREMENT_ADAPTERS];
  if (!adapter) throw new Error("PROTECTED_POLICY_UNSUPPORTED_CHECK_TYPE");
  for (const descriptor of [...COMMON_REQUIREMENTS, ...adapter.fields]) {
    const field = policy.fields[descriptor.name];
    if (!isPlainRecord(field) || field.effect !== descriptor.effect || field.comparison !== descriptor.comparison) {
      throw new Error("PROTECTED_POLICY_REQUIRED_FIELD_MISSING");
    }
  }
  for (const source of policy.sources) {
    if (!isPlainRecord(source)
      || !["checkly-api", "project-default", "check-group", "check", "imported-source", "playwright-config"].includes(String(source.kind))
      || typeof source.identity !== "string" || !source.identity || source.identity.length > 512
      || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) {
      throw new Error("PROTECTED_POLICY_SOURCE_INVALID");
    }
  }
  for (const [key, field] of Object.entries(policy.fields)) {
    if (!/^[a-z][A-Za-z0-9._-]{0,127}$/.test(key) || !isPlainRecord(field)
      || !["protected", "metadata"].includes(String(field.effect))
      || !["exact", "set-equal", "required-tuples"].includes(String(field.comparison))
      || !isPlainRecord(field.original)
      || !["known", "unknown"].includes(String(field.original.state))) {
      throw new Error("PROTECTED_POLICY_FIELD_INVALID");
    }
    if (![...COMMON_REQUIREMENTS, ...adapter.fields].some((descriptor) => descriptor.name === key)
      && (field.effect !== "protected" || field.comparison !== "exact" || field.original.state !== "unknown"
        || field.original.reason !== "UNSUPPORTED_SETTING")) {
      throw new Error("PROTECTED_POLICY_FIELD_INVALID");
    }
    if (field.original.state === "known" && !isJsonValue(field.original.value)) throw new Error("PROTECTED_POLICY_FIELD_INVALID");
    if (field.original.state === "unknown"
      && !["CONFIG_NOT_RETURNED", "DYNAMIC_VALUE_UNRESOLVED", "UNSUPPORTED_SETTING", "SOURCE_UNAVAILABLE"].includes(String(field.original.reason))) {
      throw new Error("PROTECTED_POLICY_FIELD_INVALID");
    }
  }
  if (Buffer.byteLength(policyBody(policy as unknown as ProtectedRequirementsPolicy), "utf8") > 1024 * 1024) {
    throw new Error("PROTECTED_POLICY_BOUND");
  }
}

export function assertProtectedPolicyEnvelope(envelope: unknown): asserts envelope is ProtectedPolicyEnvelope {
  if (!isPlainRecord(envelope) || typeof envelope.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(envelope.sha256)) {
    throw new Error("PROTECTED_POLICY_DIGEST_INVALID");
  }
  assertProtectedRequirementsPolicy(envelope.policy);
  const expected = Buffer.from(sha256(policyBody(envelope.policy)), "hex");
  const actual = Buffer.from(envelope.sha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("PROTECTED_POLICY_DIGEST_MISMATCH");
}

function same(a: JsonValue, b: JsonValue): boolean {
  return canonical(a) === canonical(b);
}

function compareKnown(comparison: ProtectedComparison, original: JsonValue, candidate: JsonValue): boolean | null {
  if (comparison === "exact") return same(original, candidate);
  if (!Array.isArray(original) || !Array.isArray(candidate)) return null;
  if (comparison === "set-equal") {
    const left = [...new Set(original.map((value) => canonical(value)))].sort();
    const right = [...new Set(candidate.map((value) => canonical(value)))].sort();
    return same(left, right);
  }
  // Required assertion tuples may be preserved with safe additional assertions.
  const candidateTuples = new Set(candidate.map((value) => canonical(value)));
  return original.every((value) => candidateTuples.has(canonical(value)));
}

/**
 * Compare resolved candidate behavior against the sealed original policy.
 * Unknown/missing values never pass. Candidate-only settings are inconclusive
 * until an adapter classifies their effect; candidate input cannot choose the
 * comparison operator or weaken the original requirements.
 */
export function compareProtectedRequirements(
  envelope: ProtectedPolicyEnvelope,
  candidate: CandidateEffectiveRequirements,
): ProtectedRequirementsComparison {
  assertProtectedPolicyEnvelope(envelope);
  const { policy } = envelope;
  const reasonCodes = new Set<string>();
  const changedMetadata: string[] = [];
  if (candidate.identityResolved === false) reasonCodes.add("PROTECTED_CHECK_IDENTITY_UNRESOLVED");
  else if (candidate.check.id !== policy.check.id || candidate.check.logicalId !== policy.check.logicalId
    || candidate.check.checkType !== policy.check.checkType) reasonCodes.add("PROTECTED_CHECK_IDENTITY_CHANGED");

  for (const [name, requirement] of Object.entries(policy.fields)) {
    const actual = candidate.fields[name];
    if (requirement.original.state !== "known" || !actual || actual.state !== "known") {
      if (requirement.effect === "protected") reasonCodes.add("PROTECTED_REQUIREMENT_UNRESOLVED");
      continue;
    }
    const matches = compareKnown(requirement.comparison, requirement.original.value, actual.value);
    if (matches === null) {
      if (requirement.effect === "protected") reasonCodes.add("PROTECTED_REQUIREMENT_UNRESOLVED");
    } else if (!matches) {
      if (requirement.effect === "protected") reasonCodes.add("PROTECTED_REQUIREMENT_CHANGED");
      else changedMetadata.push(name);
    }
  }
  for (const name of Object.keys(candidate.fields)) {
    if (!(name in policy.fields)) reasonCodes.add("CANDIDATE_SETTING_UNCLASSIFIED");
  }
  const codes = [...reasonCodes].sort();
  return {
    verdict: codes.includes("PROTECTED_CHECK_IDENTITY_CHANGED") || codes.includes("PROTECTED_REQUIREMENT_CHANGED")
      ? "FAILED" : codes.length ? "UNCERTAIN" : "PASS",
    reasonCodes: codes,
    changedMetadata: changedMetadata.sort(),
  };
}
