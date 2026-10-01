// The one incident check this adapter can interpret. This is *not* inferred
// from the project-level checkly.config.ts (which also defines other checks)
// or from a result's human-readable name. The executed construct, its exact
// entrypoint, deployed Checkly check, and its effective configuration must
// all describe the same transaction before a remote recording can be bound.
import type { ChecklyCheck } from "../checkly/types.ts";
import type { ManifestV3 } from "../bundle/types.ts";
import type { MultiStepSourceModel } from "./source.ts";

export const MULTISTEP_LOGICAL_ID = "slots-booking-multistep";
export const MULTISTEP_CHECK_NAME = "slots booking multistep transaction";
export const MULTISTEP_CONSTRUCT_FILE = "checks/multistep-booking.check.ts";
export const MULTISTEP_ENTRYPOINT = "checks/multistep-booking.spec.ts";
export const MULTISTEP_LOCATIONS = ["us-east-1", "eu-west-1"] as const;
export const MULTISTEP_TAGS = ["slots-booking", "verify-fix-example", "multistep"] as const;
export const MULTISTEP_ENV = [
  { key: "ENVIRONMENT_URL", secret: false },
  { key: "MULTISTEP_USER_US_EAST_1", secret: true },
  { key: "MULTISTEP_USER_EU_WEST_1", secret: true },
  { key: "VERCEL_AUTOMATION_BYPASS_SECRET", secret: true },
] as const;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const envIdentity = (items: Array<{ key: string; secret?: boolean | null }>): Array<{ key: string; secret: boolean }> =>
  items.map((item) => ({ key: item.key, secret: item.secret === true }));

/** Fixed category, never source text, an env value, or an API exception. */
export function canonicalMultiStepIdentityProblem(model: MultiStepSourceModel | null): string | null {
  const c = model?.construct;
  if (!model || model.errors.length || !c || !c.executed || !model.script || model.script.file !== MULTISTEP_ENTRYPOINT
    || c.logicalId !== MULTISTEP_LOGICAL_ID || c.name !== MULTISTEP_CHECK_NAME
    || c.entrypoint !== MULTISTEP_ENTRYPOINT
    || !same(c.locations, MULTISTEP_LOCATIONS) || !same(c.tags, MULTISTEP_TAGS)
    || c.frequencyMinutes !== 5 || c.runParallel !== true || c.doubleCheck !== false || c.activated !== true || c.muted !== false
    || !same(envIdentity(c.environmentDefinitions), MULTISTEP_ENV)
    || !same(c.environmentKeys, MULTISTEP_ENV.map((item) => item.key))) return "MULTISTEP_CONSTRUCT_IDENTITY_INVALID";
  return null;
}

/** The Checkly API's deployed script is independently compared byte-for-byte
 * with the *actual* construct entrypoint before any project file is saved.
 * A same-basename file elsewhere does not satisfy this comparison. */
interface DeployedProblem {
  problem: string | null;
  /** Mismatched field names only — never values or raw provider text. */
  fields: string[];
}

/**
 * The canonical no-retry representation is EXACTLY `doubleCheck: false` plus
 * `retryStrategy: null` (verified Checkly 9.5.0 GET-check response). Missing or
 * contradictory retry information is never equivalent to it: doubleCheck:true,
 * any retry strategy, or an absent doubleCheck/retryStrategy field is rejected.
 */
/**
 * Official Checkly 9.5.0 `frequencyOffset` semantics (Public API check schema
 * and the constructs' Frequency class): SECONDS. frequency 0 (sub-minute) is
 * driven by an offset of exactly 10, 20 or 30; a minute frequency may carry a
 * provider-generated spread of 1..floor(frequency*10) up to 60 minutes and
 * 1..ceil(frequency/60) above that; 0 means disabled. When the construct
 * omits the offset, the backend may still generate one — that metadata alone
 * is admitted, never an arbitrary or out-of-range value.
 */
function providerGeneratedFrequencyOffset(offset: unknown, frequency: number | null): boolean {
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset <= 0) return false;
  if (frequency === null || !Number.isSafeInteger(frequency) || frequency < 0) return false;
  if (frequency === 0) return offset === 10 || offset === 20 || offset === 30;
  return offset <= (frequency <= 60 ? Math.floor(frequency * 10) : Math.ceil(frequency / 60));
}

export function deployedProblem(check: ChecklyCheck, model: MultiStepSourceModel | null,
  sourceText: string | null): DeployedProblem {
  if (!model || model.construct === null || canonicalMultiStepIdentityProblem(model)) return { problem: "MULTISTEP_CONSTRUCT_IDENTITY_INVALID", fields: [] };
  if (check.checkType !== "MULTI_STEP" || check.name !== MULTISTEP_CHECK_NAME || !check.id
    || typeof check.script !== "string" || !sourceText || check.script !== sourceText
    || (check.scriptPath !== MULTISTEP_ENTRYPOINT && check.scriptPath !== "multistep-booking.spec.ts")) {
    return { problem: "MULTISTEP_DEPLOYED_SOURCE_MISMATCH", fields: [] };
  }
  const fields: string[] = [];
  if (check.frequency !== 5) fields.push("frequency");
  if (check.activated !== true) fields.push("activated");
  if (check.muted !== false) fields.push("muted");
  if (check.runParallel !== true) fields.push("runParallel");
  if (!same(check.locations, MULTISTEP_LOCATIONS)) fields.push("locations");
  if (!same(check.tags, MULTISTEP_TAGS)) fields.push("tags");
  if (!same(envIdentity(check.environmentVariables ?? []), MULTISTEP_ENV)) fields.push("environmentVariables");
  if ((check.privateLocations?.length ?? 0) !== 0) fields.push("privateLocations");
  if (check.groupId != null) fields.push("groupId");
  if (check.runtimeId != null) fields.push("runtimeId");
  if (check.playwrightConfig != null) fields.push("playwrightConfig");
  if (check.testOnly === true) fields.push("testOnly");
  if (check.shouldFail === true) fields.push("shouldFail");
  // Source-controlled offset: the deployed check must equal it exactly.
  // Omitted from source: only the provider-generated metadata above passes.
  if (model.construct !== null && model.construct.frequencyOffsetSeconds !== null) {
    if (check.frequencyOffset !== model.construct.frequencyOffsetSeconds) fields.push("frequencyOffset");
  } else if (check.frequencyOffset != null && check.frequencyOffset !== 0
    && !providerGeneratedFrequencyOffset(check.frequencyOffset, check.frequency)) {
    fields.push("frequencyOffset");
  }
  if (check.doubleCheck !== false) fields.push("doubleCheck");
  if (check.retryStrategy !== null) fields.push("retryStrategy");
  if (check.intent != null) fields.push("intent");
  if (check.aiAutoRepairEnabled === true) fields.push("aiAutoRepairEnabled");
  if (check.pwProjects?.length) fields.push("pwProjects");
  if (check.pwTags?.length) fields.push("pwTags");
  if (check.playwrightConfigPath) fields.push("playwrightConfigPath");
  if (check.installCommand) fields.push("installCommand");
  if (check.testCommand) fields.push("testCommand");
  if (check.request) fields.push("request");
  if (fields.length) return { problem: "MULTISTEP_DEPLOYED_CONFIG_MISMATCH", fields };
  return { problem: null, fields: [] };
}

export function deployedMultiStepProblem(check: ChecklyCheck, model: MultiStepSourceModel | null,
  sourceText: string | null): string | null {
  return deployedProblem(check, model, sourceText).problem;
}

/** Mismatched deployed-config field names only — safe for diagnostics. */
export function deployedProblemFields(check: ChecklyCheck, model: MultiStepSourceModel | null,
  sourceText: string | null): string[] {
  return deployedProblem(check, model, sourceText).fields;
}

// A stored config must be the exact sanitized projection. An extra field
// cannot be smuggled into a manifest and silently ignored on reload (e.g.
// shouldFail, a private runtime override, or an unredacted environment value).
const STORED_CONFIG_KEYS = new Set(["frequencyMinutes", "locations", "privateLocations",
  "runParallel", "retryStrategy", "doubleCheck", "activated", "muted", "tags", "runtimeId",
  "environmentVariables", "playwright", "apiRequest", "repair"]);
function storedConfigShape(m: ManifestV3): boolean {
  const config = m.config;
  if (!config || Object.keys(config).length !== STORED_CONFIG_KEYS.size
    || Object.keys(config).some((key) => !STORED_CONFIG_KEYS.has(key))
    || !Array.isArray(config.environmentVariables)
    || config.environmentVariables.some((item) => !item || Object.keys(item).length !== 2
      || !Object.hasOwn(item, "key") || !Object.hasOwn(item, "secret"))
    || !config.repair || Object.keys(config.repair).length !== 2
    || !Object.hasOwn(config.repair, "intent") || !Object.hasOwn(config.repair, "aiAutoRepairEnabled")) return false;
  return true;
}

/** The sanitized, stored manifest must agree with the immutable construct;
 * dropping a masking field while projecting API data cannot turn it valid. */
export function storedMultiStepIdentityProblem(m: ManifestV3, model: MultiStepSourceModel | null): string | null {
  if (canonicalMultiStepIdentityProblem(model)) return "MULTISTEP_CONSTRUCT_IDENTITY_INVALID";
  if (!storedConfigShape(m)) return "MULTISTEP_DEPLOYED_CONFIG_MISMATCH";
  if (m.check.logicalId !== MULTISTEP_LOGICAL_ID || m.check.name !== MULTISTEP_CHECK_NAME
    || m.check.file !== MULTISTEP_ENTRYPOINT || m.check.deployedId !== m.check.id
    || !m.check.files.includes(MULTISTEP_CONSTRUCT_FILE)
    || m.config.frequencyMinutes !== 5 || m.config.activated !== true || m.config.muted !== false
    || m.config.runParallel !== true || !same(m.config.locations, MULTISTEP_LOCATIONS)
    || !same(m.config.tags, MULTISTEP_TAGS)
    || !same(envIdentity(m.config.environmentVariables), MULTISTEP_ENV)
    || m.config.privateLocations.length !== 0 || m.config.runtimeId !== null
    || m.config.retryStrategy !== null
    || m.config.doubleCheck !== false || m.config.apiRequest !== null
    || m.config.playwright !== null || m.config.repair.intent !== null
    || m.config.repair.aiAutoRepairEnabled === true) return "MULTISTEP_DEPLOYED_CONFIG_MISMATCH";
  return null;
}
