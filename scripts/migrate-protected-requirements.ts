#!/usr/bin/env node
// Phase 9 Stage 2 — bundle migration.
//
// Adds a sealed protected-requirements policy to bundles captured before
// Phase 9. Requirements come from the BUNDLE'S OWN recorded evidence (its
// manifest config, its captured check identity and its captured source), never
// from candidate files and never from an assumed Checkly default.
//
// Anything the bundle does not record resolves to UNKNOWN, which can never
// produce PASS. Migration therefore never invents a value to make a bundle
// look compliant — it records what is actually known.
//
//   node scripts/migrate-protected-requirements.ts [--write] [--digest-out <file>]
//
// Without --write it only reports what would change.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildProtectedRequirements, sealProtectedRequirements, type ProtectedRequirementsInput, type ResolvedPolicyValue } from "../src/protected-requirements.ts";
import { parseApiCheckProject } from "../src/api/model.ts";
import { parseMultiStepProject } from "../src/multistep/source.ts";
import { resolveEffectivePlaywrightModel } from "../src/protected/playwright-model.ts";

const BUNDLES = [
  "fixtures/bundles/slots-booking-overlap",
  "fixtures/bundles/slots-booking-drift",
  "incidents/slots-availability-api",
  "incidents/slots-multistep-nested-response",
];

const known = (value: unknown): ResolvedPolicyValue =>
  value === undefined ? { state: "unknown", reason: "CONFIG_NOT_RETURNED" } : { state: "known", value: value as never };
const unknown = (reason: "CONFIG_NOT_RETURNED" | "DYNAMIC_VALUE_UNRESOLVED" | "UNSUPPORTED_SETTING" | "SOURCE_UNAVAILABLE" = "CONFIG_NOT_RETURNED"): ResolvedPolicyValue =>
  ({ state: "unknown", reason });

/** Real content digest of the bundle's own captured evidence. Never invented. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Manifest { check: { id?: string; logicalId?: string | null; checkType?: string; projectCommit?: string | null };
  config: Record<string, unknown>; protectedRequirements?: unknown; [k: string]: unknown }

function buildValues(manifest: Manifest, root: string): { values: Record<string, ResolvedPolicyValue>; sources: { kind: "checkly-api" | "check"; identity: string; sha256: string }[] } {
  const config = manifest.config ?? {};
  const values: Record<string, ResolvedPolicyValue> = {
    "check.name": known(config.name),
    activated: known(config.activated),
    muted: known(config.muted),
    shouldFail: known(config.shouldFail),
    frequency: known(config.frequencyMinutes),
    locations: known(config.locations),
    privateLocations: known(config.privateLocations),
    runParallel: known(config.runParallel),
    retryStrategy: known(config.retryStrategy),
    alertBehavior: unknown("UNSUPPORTED_SETTING"),
    environmentVariableNames: known(Array.isArray(config.environmentVariables)
      ? config.environmentVariables.map((entry) => (entry as { key: string }).key) : undefined),
    targetResolution: known("code"),
  };

  const checkType = String(manifest.check.checkType ?? "");
  if (checkType === "API") {
    const file = join(root, "check", "checks/availability.check.ts");
    let model: ReturnType<typeof parseApiCheckProject> | null = null;
    try { model = parseApiCheckProject("checks/availability.check.ts", new Map([["checks/availability.check.ts", readFileSync(file, "utf8")]])); } catch { model = null; }
    values["api.requestMethod"] = known(model?.request.method);
    values["api.urlStructure"] = known(model?.request.url);
    values["api.assertions"] = known(model?.request.assertions.map((a) => ({ id: a.assertion.id, subject: a.assertion.subject, matcher: a.assertion.matcher, target: a.assertion.target })));
    values["api.setupScript"] = known(model?.setupFile ?? null);
    values["api.tearDownFile"] = known(model?.teardownFile ?? null);
  } else if (checkType === "MULTI_STEP") {
    const file = join(root, "check", String(manifest.check.file ?? ""));
    let model: ReturnType<typeof parseMultiStepProject> | null = null;
    try { model = parseMultiStepProject(new Map([[String(manifest.check.file), readFileSync(file, "utf8")]]), String(manifest.check.file)); } catch { model = null; }
    values["multistep.orderedSteps"] = known(model?.script?.steps.map((s) => s.title));
    values["multistep.assertions"] = known(model?.script?.assertions.map((a) => ({ id: a.id, subject: a.subject, matcher: a.matcher, target: a.target })));
    values["multistep.runtime"] = unknown("CONFIG_NOT_RETURNED");
    values["multistep.routesAndMethods"] = unknown("SOURCE_UNAVAILABLE");
    values["multistep.environmentMapping"] = unknown("DYNAMIC_VALUE_UNRESOLVED");
    values["multistep.runtimeTransaction"] = unknown("SOURCE_UNAVAILABLE");
  } else if (checkType === "PLAYWRIGHT" || checkType === "BROWSER") {
    // The bundle captures checkly.config.ts, playwright.config.ts and the spec.
    // The effective Playwright model therefore IS resolvable offline; a field
    // that still cannot be read stays UNKNOWN rather than being given a default.
    const pwConfigPath = typeof config.playwrightConfigPath === "string" ? config.playwrightConfigPath
      : (typeof config.playwrightConfigFile === "string" ? config.playwrightConfigFile : "playwright.config.ts");
    let pwSource = "";
    try { pwSource = readFileSync(join(root, "check", pwConfigPath), "utf8"); } catch { pwSource = ""; }
    let checklySource = "";
    try { checklySource = readFileSync(join(root, "check", "checkly.config.ts"), "utf8"); } catch { checklySource = ""; }
    const model = resolveEffectivePlaywrightModel(pwSource, checklySource, pwConfigPath);
    values["playwright.configPath"] = known(model.configPath);
    values["playwright.projects"] = known(model.projects);
    values["playwright.tags"] = known(model.tags);
    values["playwright.testSelection"] = known(model.testSelection);
    values["playwright.retries"] = known(model.retries);
    // The check targets whatever ENVIRONMENT_URL resolves to. A hardcoded
    // fallback URL is recorded so a candidate that pins a host is convicted.
    values["playwright.target"] = known(model.targetVariable
      ? `env:${model.targetVariable}${model.targetFallback ? `|fallback:${model.targetFallback}` : ""}` : undefined);
    values["playwright.runtime"] = unknown("CONFIG_NOT_RETURNED");
  } else {
    for (const name of ["browser.entrypoint", "browser.runtime", "browser.assertions", "browser.target"]) {
      values[name] = unknown("SOURCE_UNAVAILABLE");
    }
  }
  values["execution.dependencyMetadata"] = unknown("CONFIG_NOT_RETURNED");

  // The source identity is a real digest over the bundle's own captured
  // evidence. A digest is never invented to satisfy the schema.
  const capturedFile = join(root, "check", String(manifest.check.file ?? ""));
  let captured = "";
  try { captured = readFileSync(capturedFile, "utf8"); } catch { captured = ""; }
  const digest = sha256Hex(`${manifest.check.file ?? ""}\u0000${captured}\u0000${JSON.stringify(manifest.config ?? {})}`);
  return { values, sources: [{ kind: "checkly-api", identity: String(manifest.check.id ?? "unknown"), sha256: digest }] };
}

const write = process.argv.includes("--write");
const digestOut = (() => { const i = process.argv.indexOf("--digest-out"); return i >= 0 ? process.argv[i + 1] : null; })();

for (const relative of BUNDLES) {
  const root = resolve(relative);
  const path = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  const already = Boolean(manifest.protectedRequirements);

  const input: ProtectedRequirementsInput = {
    check: { id: String(manifest.check.id ?? "unknown"), logicalId: manifest.check.logicalId ?? null, checkType: String(manifest.check.checkType ?? "UNKNOWN") },
    ...buildValues(manifest, root),
  };
  const built = buildProtectedRequirements(input);
  if (built.status !== "ready") {
    process.stdout.write(`${relative}: no adapter for ${input.check.checkType} — skipped\n`);
    continue;
  }
  const envelope = sealProtectedRequirements(built.envelope.policy);
  const knownCount = Object.values(built.envelope.policy.fields).filter((f) => f.original.state === "known").length;
  const total = Object.keys(built.envelope.policy.fields).length;
  manifest.protectedRequirements = envelope;
  process.stdout.write(`${relative}: ${already ? "already present" : "absent"} → sealed ${knownCount}/${total} known fields, sha256:${envelope.sha256.slice(0, 16)}…\n`);
  if (write) writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (digestOut && relative === BUNDLES[0]) {
    writeFileSync(digestOut, `${envelope.sha256}\n`, "utf8");
  }
}