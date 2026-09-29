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
export function deployedMultiStepProblem(check: ChecklyCheck, model: MultiStepSourceModel | null,
  sourceText: string | null): string | null {
  if (canonicalMultiStepIdentityProblem(model)) return "MULTISTEP_CONSTRUCT_IDENTITY_INVALID";
  if (check.checkType !== "MULTI_STEP" || check.name !== MULTISTEP_CHECK_NAME || !check.id
    || typeof check.script !== "string" || !sourceText || check.script !== sourceText
    || (check.scriptPath !== MULTISTEP_ENTRYPOINT && check.scriptPath !== "multistep-booking.spec.ts")) {
    return "MULTISTEP_DEPLOYED_SOURCE_MISMATCH";
  }
  if (check.frequency !== 5 || check.activated !== true || check.muted !== false
    || check.runParallel !== true || !same(check.locations, MULTISTEP_LOCATIONS)
    || !same(check.tags, MULTISTEP_TAGS)
    || !same(envIdentity(check.environmentVariables ?? []), MULTISTEP_ENV)
    || (check.privateLocations?.length ?? 0) !== 0 || check.groupId != null
    || check.runtimeId != null || check.playwrightConfig != null
    || check.testOnly === true || check.shouldFail === true
    || check.frequencyOffset != null && check.frequencyOffset !== 0
    || check.doubleCheck !== false || check.retryStrategy != null
    || check.intent != null || check.aiAutoRepairEnabled === true
    || check.pwProjects?.length || check.pwTags?.length || check.playwrightConfigPath
    || check.installCommand || check.testCommand || check.request) {
    return "MULTISTEP_DEPLOYED_CONFIG_MISMATCH";
  }
  return null;
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
