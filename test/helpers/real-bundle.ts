// Loads a REAL captured bundle (fixtures/bundles/<name>) back into the shape
// buildManifest consumes. The raw trace zips are not in git (raw/ is ignored),
// so the trace extract is rebuilt from the HAR and the action list the bundle
// already contains. Shared by the golden tests.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchedResult, ManifestInputs } from "../../src/bundle/manifest.ts";
import type { ChecklyCheck, CheckResult, CheckResultSummary, ErrorGroup, RootCauseAnalysis } from "../../src/checkly/types.ts";
import type { Har } from "../../src/trace/har-types.ts";
import type { TraceAction, TraceExtract } from "../../src/trace/trace-to-har.ts";
import type { ManifestV3 } from "../../src/bundle/types.ts";

export function summaryOf(r: CheckResult): CheckResultSummary {
  return {
    id: r.id,
    hasFailures: r.hasFailures,
    hasErrors: r.hasErrors,
    runLocation: r.runLocation,
    startedAt: r.startedAt,
    stoppedAt: r.stoppedAt,
    resultType: r.resultType,
    attempts: r.attempts,
    errorGroupIds: r.errorGroupIds,
  };
}

export function loadRealBundle(name: string) {
  const DIR = new URL(`../../fixtures/bundles/${name}/`, import.meta.url).pathname;
  const read = (rel: string) => readFileSync(join(DIR, rel), "utf8");
  const json = <T>(rel: string) => JSON.parse(read(rel)) as T;

  const captured = json<ManifestV3>("manifest.json");
  const checkConfig = json<{ check: ManifestV3["check"]; config: ManifestV3["config"]; target: ManifestV3["target"] }>("check.config.json");
  const failingResult = json<CheckResult>("results/failing.json");
  const passingResult = json<CheckResult>("results/passing.json");
  const rcaDoc = json<{ errorGroup: ManifestV3["errorGroup"]; rca: RootCauseAnalysis | null; replacedRca?: RootCauseAnalysis | null }>("rca.json");
  const historyFile = existsSync(join(DIR, "results/history.json")) ? json<CheckResultSummary[]>("results/history.json") : null;

  /** Rebuild the extract from what the bundle kept (HAR + actions without params). */
  function extractFrom(label: "failing" | "passing"): TraceExtract {
    const har = json<Har>(`recordings/${label}.har`);
    const raw = json<Array<Partial<TraceAction> & { apiName: string; title: string; error: string | null }>>(`recordings/${label}.actions.json`);
    const actions: TraceAction[] = raw.map((a) => ({
      callId: a.callId ?? "",
      apiName: a.apiName,
      title: a.title,
      category: a.category ?? (a.apiName.startsWith("Test.") ? "expect" : "browser"),
      startTime: a.startTime ?? null,
      endTime: a.endTime ?? null,
      error: a.error ?? null,
      params: a.params ?? {},
      location: a.location ?? null,
    }));
    const errored = actions.filter((a) => a.error);
    const failingAction = errored.find((a) => a.category === "expect" || a.category === "pw:api") ?? errored[0] ?? null;
    const origin = har.log.entries[0] ? new URL(har.log.entries[0].request.url).origin : null;
    return { har, actions, failingAction, baseURL: origin, browserName: "chromium", files: { network: [], trace: [], resources: 0 } };
  }

  const check: ChecklyCheck = {
    id: checkConfig.check.deployedId ?? checkConfig.check.id,
    name: captured.check.name,
    checkType: "PLAYWRIGHT",
    groupId: null,
    runtimeId: null,
    frequency: checkConfig.config.frequencyMinutes,
    locations: checkConfig.config.locations,
    runParallel: checkConfig.config.runParallel,
    activated: checkConfig.config.activated,
    muted: checkConfig.config.muted,
    tags: checkConfig.config.tags,
    environmentVariables: checkConfig.config.environmentVariables.map((e) => ({ key: e.key, value: "x", secret: e.secret })),
    playwrightVersion: checkConfig.config.playwright?.version ?? undefined,
  };

  const sources = captured.check.files.map((f) => ({ path: f, content: read(join("check", f)) }));

  function inputs(over: Partial<ManifestInputs> = {}): ManifestInputs {
    const failing: FetchedResult = { summary: summaryOf(failingResult), detail: failingResult, extract: extractFrom("failing") };
    const passing: FetchedResult = { summary: summaryOf(passingResult), detail: passingResult, extract: extractFrom("passing") };
    const history = historyFile ?? [failing.summary, passing.summary];
    const errorGroup: ErrorGroup | null = rcaDoc.errorGroup
      ? { id: rcaDoc.errorGroup.id, checkId: check.id, errorHash: "", rawErrorMessage: null, cleanedErrorMessage: rcaDoc.errorGroup.cleanedErrorMessage, firstSeen: rcaDoc.errorGroup.firstSeen, lastSeen: rcaDoc.errorGroup.lastSeen }
      : null;
    return {
      check,
      failing,
      passing,
      errorGroup,
      rca: rcaDoc.rca,
      replacedRca: rcaDoc.replacedRca ?? null,
      history,
      sources,
      mainSource: captured.check.file,
      project: { dir: "examples/slots-booking/web", gitCommit: captured.check.projectCommit, logicalId: captured.check.logicalId, repoUrl: captured.check.repo, playwright: { configPath: "./playwright.config.ts", projects: ["booking"], tags: [] } },
      measurement: null,
      recordings: { failing: "recordings/failing.har", passing: "recordings/passing.har", bodies: "api" },
      assets: [],
      apiCalls: [],
      accountId: "acct",
      now: captured.generatedAt,
      toolVersion: captured.generatedBy.split("@")[1] ?? "0.1.0",
      ...over,
    };
  }

  return { DIR, read, json, captured, checkConfig, failingResult, passingResult, rcaDoc, historyFile, check, sources, inputs };
}
