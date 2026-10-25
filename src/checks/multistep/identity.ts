// A remote deployed check is bound to the construct parsed from the captured
// project, never to one example check. The construct supplies its own logical
// ID, name, entrypoint, tags, schedule and regions; the deployed Checkly check
// must describe exactly that transaction before a remote recording is bound.
import type { ChecklyCheck } from "../../capture/checkly/types.ts";
import type { ManifestV3 } from "../../capture/bundle/types.ts";
import type { MultiStepSourceModel } from "./source.ts";
import { multiStepSourcePath } from "./files.ts";
import { isSyntacticallyValidRegion } from "./trusted-scope.ts";

/**
 * The structural env keys every Multistep check declares. Account-variable
 * NAMES are deliberately absent: they are derived from the construct's own
 * region -> key map, so a customer's own regions and names are admitted.
 */
export const MULTISTEP_STRUCTURAL_ENV_KEYS = [
  "ENVIRONMENT_URL",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
] as const;
/** Validate a construct's OWN location set: distinct, syntactically valid,
 *  and bounded. The set itself is never compared to a fixed list. */
export function isValidRegionSet(locations: unknown): locations is string[] {
  return Array.isArray(locations) && locations.length >= 1 && locations.length <= 8
    && locations.every((location) => isSyntacticallyValidRegion(location))
    && new Set(locations).size === locations.length;
}

/** A construct may declare any customer tags (or none). Bounded, static,
 *  distinct strings only: order is not significant when comparing to the
 *  deployed check. */
export function isValidTagSet(tags: unknown): tags is string[] {
  return Array.isArray(tags) && tags.length <= 16
    && tags.every((tag) => typeof tag === "string" && tag.length > 0 && tag.length <= 64)
    && new Set(tags).size === tags.length;
}

const LOGICAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
function isValidLogicalId(value: unknown): value is string {
  return typeof value === "string" && LOGICAL_ID.test(value);
}
function isValidCheckName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function isValidFrequency(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1440;
}
function isValidFrequencyOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 3600;
}
const sameSorted = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((value, index) => value === sortedB[index]);
};

/**
 * Every declared env key must be a structural key plus exactly one
 * ACCOUNT key per region — no more, no fewer.
 *
 * The account VARIABLE NAMES are not fixed: any name is accepted provided
 * there is one distinct key per declared region. Hardcoding a name would
 * reject every customer whose keys differ from the example's.
 *
 * SECURITY: every account key MUST be declared `secret: true`. A candidate that
 * flips an account variable to non-secret stores its value in plaintext, which
 * is a real weakening and is rejected here.
 */
export function hasCompleteEnvDeclarations(
  keys: unknown,
  regionCount: number,
  definitions?: ReadonlyArray<{ key: string; secret?: boolean | null }>,
): boolean {
  if (!Array.isArray(keys) || !Number.isInteger(regionCount) || regionCount < 1) return false;
  const unique = [...new Set(keys.filter((key) => typeof key === "string"))] as string[];
  if (unique.length !== keys.length) return false;
  const structural = unique.filter((key) => (MULTISTEP_STRUCTURAL_ENV_KEYS as readonly string[]).includes(key));
  if (structural.length !== MULTISTEP_STRUCTURAL_ENV_KEYS.length) return false;
  const accounts = unique.filter((key) => !(MULTISTEP_STRUCTURAL_ENV_KEYS as readonly string[]).includes(key));
  if (accounts.length !== regionCount) return false;
  if (!definitions) return true;
  // A regional account value must always be secret.
  return definitions.every((entry) => entry.key === "ENVIRONMENT_URL"
    || (MULTISTEP_STRUCTURAL_ENV_KEYS as readonly string[]).includes(entry.key)
    || entry.secret === true);
}

/** Fixed category, never source text, an env value, or an API exception. */
export function canonicalMultiStepIdentityProblem(model: MultiStepSourceModel | null): string | null {
  const c = model?.construct;
  if (!model || model.errors.length || !c || !c.executed || !model.script
    || !isValidLogicalId(c.logicalId) || !isValidCheckName(c.name)
    || !c.entrypoint || multiStepSourcePath(c.entrypoint) !== c.entrypoint
    || model.script.file !== c.entrypoint
    || !model.constructFile || multiStepSourcePath(model.constructFile) !== model.constructFile
    || !isValidRegionSet(c.locations) || !isValidTagSet(c.tags)
    || !isValidFrequency(c.frequencyMinutes)
    || (c.frequencyOffsetSeconds !== null && !isValidFrequencyOffset(c.frequencyOffsetSeconds))
    || c.runParallel !== true || c.doubleCheck !== false || c.activated !== true || c.muted !== false
    || !hasCompleteEnvDeclarations(c.environmentKeys, c.locations.length, c.environmentDefinitions)) return "MULTISTEP_CONSTRUCT_IDENTITY_INVALID";
  return null;
}

/** The Checkly API's deployed script is independently compared byte-for-byte
 * with the *actual* construct entrypoint before any project file is saved.
 * The provider may report its project-relative entrypoint exactly, or only its
 * basename; either must name this construct's own entrypoint. A same-basename
 * file in a different directory is still rejected. */
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
  const c = model?.construct;
  if (!model || !c || canonicalMultiStepIdentityProblem(model)) return { problem: "MULTISTEP_CONSTRUCT_IDENTITY_INVALID", fields: [] };
  const entrypoint = c.entrypoint!;
  const bareEntrypoint = entrypoint.split("/").at(-1);
  if (check.checkType !== "MULTI_STEP" || check.name !== c.name || !check.id
    || typeof check.script !== "string" || !sourceText || check.script !== sourceText
    || (check.scriptPath !== entrypoint && check.scriptPath !== bareEntrypoint)) {
    return { problem: "MULTISTEP_DEPLOYED_SOURCE_MISMATCH", fields: [] };
  }
  const fields: string[] = [];
  if (check.frequency !== c.frequencyMinutes) fields.push("frequency");
  if (check.activated !== true) fields.push("activated");
  if (check.muted !== false) fields.push("muted");
  if (check.runParallel !== true) fields.push("runParallel");
  if (!isValidRegionSet(check.locations) || !sameSorted(check.locations, c.locations)) fields.push("locations");
  if (!isValidTagSet(check.tags) || !sameSorted(check.tags, c.tags)) fields.push("tags");
  const declared = check.environmentVariables ?? [];
  const declaredKeys = declared.map((entry) => entry.key);
  if (!hasCompleteEnvDeclarations(declaredKeys, (check.locations ?? []).length, declared)
    || !sameSorted(declaredKeys, c.environmentKeys)) fields.push("environmentVariables");
  if ((check.privateLocations?.length ?? 0) !== 0) fields.push("privateLocations");
  if (check.groupId != null) fields.push("groupId");
  if (check.runtimeId != null) fields.push("runtimeId");
  if (check.playwrightConfig != null) fields.push("playwrightConfig");
  if (check.testOnly === true) fields.push("testOnly");
  if (check.shouldFail === true) fields.push("shouldFail");
  // Source-controlled offset: the deployed check must equal it exactly.
  // Omitted from source: only the provider-generated metadata above passes.
  if (c.frequencyOffsetSeconds !== null) {
    if (check.frequencyOffset !== c.frequencyOffsetSeconds) fields.push("frequencyOffset");
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
  const c = model?.construct;
  if (!model || !c || canonicalMultiStepIdentityProblem(model)) return "MULTISTEP_CONSTRUCT_IDENTITY_INVALID";
  if (!storedConfigShape(m)) return "MULTISTEP_DEPLOYED_CONFIG_MISMATCH";
  if (m.check.logicalId !== c.logicalId || m.check.name !== c.name
    || m.check.file !== c.entrypoint || m.check.deployedId !== m.check.id
    || !model.constructFile || !m.check.files.includes(model.constructFile)
    || m.config.frequencyMinutes !== c.frequencyMinutes || m.config.activated !== true || m.config.muted !== false
    || m.config.runParallel !== true || !isValidRegionSet(m.config.locations)
    || !sameSorted(m.config.locations, c.locations)
    || !isValidTagSet(m.config.tags) || !sameSorted(m.config.tags, c.tags)
    || !hasCompleteEnvDeclarations(m.config.environmentVariables.map((entry) => entry.key), m.config.locations.length, m.config.environmentVariables)
    || !sameSorted(m.config.environmentVariables.map((entry) => entry.key), c.environmentKeys)
    || m.config.privateLocations.length !== 0 || m.config.runtimeId !== null
    || m.config.retryStrategy !== null
    || m.config.doubleCheck !== false || m.config.apiRequest !== null
    || m.config.playwright !== null || m.config.repair.intent !== null
    || m.config.repair.aiAutoRepairEnabled === true) return "MULTISTEP_DEPLOYED_CONFIG_MISMATCH";
  return null;
}
