// Manifest v3 builder — a pure function from what was fetched to what is
// written. No network, no filesystem: everything here is unit-testable and
// deterministic for the same inputs.

import { parseInventory } from "../assertion/inventory.ts";
import { fnv1a } from "../assertion/id.ts";
import type { AssertionInventory } from "../types.ts";
import type { ChecklyCheck, CheckResult, CheckResultSummary, ErrorGroup, PlaywrightResultError, RootCauseAnalysis } from "../checkly/types.ts";
import { stripAnsi, type TraceExtract } from "../trace/trace-to-har.ts";
import type { HarEntry } from "../trace/har-types.ts";
import { envVarNamesOnly } from "./sanitize.ts";
import { classifyRca } from "./rca-mode.ts";
import type { MeasureResult } from "./measure.ts";
import type { DeterminismV3, FailurePoint, ManifestV3, OverlappingRun, ResultRef, SceneV3 } from "./types.ts";

export interface FetchedResult {
  summary: CheckResultSummary;
  detail: CheckResult | null;
  extract: TraceExtract | null;
}

export interface ManifestInputs {
  check: ChecklyCheck;
  failing: FetchedResult | null;
  passing: FetchedResult | null;
  errorGroup: ErrorGroup | null;
  rca: RootCauseAnalysis | null;
  /** the group's earlier RCA when `--trigger-rca` replaced it with a fresh one */
  replacedRca?: RootCauseAnalysis | null;
  history: CheckResultSummary[];
  sources: Array<{ path: string; content: string }>;
  mainSource: string | null;
  project: {
    dir: string | null;
    gitCommit: string | null;
    logicalId: string | null;
    repoUrl: string | null;
    /** from the project's checkly.config.*; used when the API does not return these for PLAYWRIGHT checks */
    playwright?: { configPath: string | null; projects: string[]; tags: string[] };
  };
  measurement: MeasureResult | null;
  recordings: { failing: string | null; passing: string | null; bodies: string };
  assets: ManifestV3["provenance"]["assets"];
  apiCalls: ManifestV3["provenance"]["apiCalls"];
  accountId: string;
  now: string;
  toolVersion: string;
}

const REPS = 5;

function errorMessage(e: PlaywrightResultError | string): string {
  if (typeof e === "string") return stripAnsi(e);
  if (e && typeof e === "object") return stripAnsi(e.error?.message ?? JSON.stringify(e));
  return String(e);
}

/** Every error message a result carries, whatever the check type. */
export function resultErrors(detail: CheckResult | null): string[] {
  if (!detail) return [];
  const out: string[] = [];
  if (Array.isArray(detail.errors)) out.push(...detail.errors.map(errorMessage));
  const r = detail.playwrightCheckResult ?? detail.browserCheckResult ?? detail.multiStepCheckResult;
  if (r?.errors?.length) out.push(...r.errors.map((e) => errorMessage(e as PlaywrightResultError | string)));
  if (detail.apiCheckResult?.requestError) out.push(detail.apiCheckResult.requestError);
  return out.map((m) => m.slice(0, 2000));
}

/** `at /tmp/…/user/tests/booking.spec.ts:36:51` or `> 36 |` → the spec line of the failure. */
export function specLocation(message: string, testFile: string | null): { file: string | null; line: number | null; column: number | null } {
  const at = /at\s+(?:.*[\\/])?([\w.-]+\.(?:spec|test)\.[cm]?[jt]sx?):(\d+):(\d+)/.exec(message);
  if (at) return { file: testFile ?? at[1], line: Number(at[2]), column: Number(at[3]) };
  const marker = /^>\s*(\d+)\s*\|/m.exec(message);
  if (marker) return { file: testFile, line: Number(marker[1]), column: null };
  return { file: testFile, line: null, column: null };
}

export function failingTestOf(detail: CheckResult | null): ResultRef["failingTest"] {
  // Live API: errors sit under playwrightCheckResult (browser/multistep alike);
  // the bundle's trimmed results/*.json lifts them to the top level. Read both.
  const nested = (detail?.playwrightCheckResult ?? detail?.browserCheckResult ?? detail?.multiStepCheckResult)?.errors;
  const pool = [...(Array.isArray(detail?.errors) ? detail!.errors : []), ...(Array.isArray(nested) ? nested : [])];
  const first = pool.find((e): e is PlaywrightResultError => !!e && typeof e === "object");
  if (!first) return null;
  const loc = specLocation(first.error?.message ?? "", first.testFile ?? null);
  return { file: first.testFile ?? null, title: first.testTitle ?? null, project: first.projectName ?? null, line: loc.line, column: loc.column };
}

/**
 * One line for humans out of a Playwright error message:
 * `expect(locator).toHaveText(expected) failed` + Locator/Expected/Received.
 */
export function summarizeErrorMessage(message: string): string {
  const lines = message.split("\n").map((l) => l.trim());
  const head = (lines.find((l) => l) ?? "").replace(/^Error:\s*/, "").replace(/\s+failed$/, " failed");
  const pick = (label: string) => lines.find((l) => l.startsWith(label + ":"))?.slice(label.length + 1).trim();
  const locator = pick("Locator");
  const expected = pick("Expected");
  const received = pick("Received");
  const reason = received ? null : lines.slice(1).map((l) => /^Error:\s*(.+)$/.exec(l)?.[1]).find((v) => v && !/^expect\(/.test(v)) ?? null;
  const bits = [locator ? `on ${locator}` : null, expected ? `expected ${expected}` : null, received ? `received ${received}` : reason ? reason : null].filter(Boolean);
  const out = bits.length ? `${head} — ${bits.join(", ")}` : head;
  return out.length > 160 ? out.slice(0, 159) + "…" : out;
}

function toRef(r: FetchedResult | null): ResultRef | null {
  if (!r) return null;
  return {
    id: r.summary.id,
    startedAt: r.summary.startedAt,
    stoppedAt: r.summary.stoppedAt ?? r.detail?.stoppedAt ?? null,
    runLocation: r.summary.runLocation,
    resultType: r.summary.resultType ?? null,
    attempts: r.summary.attempts ?? null,
    errorGroupIds: r.summary.errorGroupIds ?? [],
    errors: resultErrors(r.detail),
    failingTest: failingTestOf(r.detail),
    trace: r.extract
      ? { files: [...r.extract.files.network, ...r.extract.files.trace], entries: r.extract.har.log.entries.length, actions: r.extract.actions.length }
      : null,
  };
}

function isApiLike(e: HarEntry): boolean {
  const t = (e._resourceType ?? "").toLowerCase();
  if (t === "xhr" || t === "fetch") return true;
  const mime = e.response.content.mimeType ?? "";
  return /json/i.test(mime);
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The assertion id on a given spec line (duplicates by id are kept here, unlike the merged inventory). */
export function assertionIdAtLine(sources: Array<{ path: string; content: string }>, file: string | null, line: number): string | null {
  const candidates = file ? sources.filter((s) => s.path === file || s.path.endsWith("/" + file) || file.endsWith("/" + s.path) || basenameOf(s.path) === basenameOf(file)) : [];
  const specs = candidates.length ? candidates : sources.filter((s) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(s.path));
  for (const s of specs) {
    const hit = parseInventory(s.path, s.content).assertions.find((a) => a.sourceLine === line);
    if (hit) return hit.id;
  }
  return null;
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function detectFailurePoint(
  failing: TraceExtract | null,
  passing: TraceExtract | null,
  resultDetail: CheckResult | null = null,
  sources: Array<{ path: string; content: string }> = [],
): FailurePoint | null {
  if (!failing) return null;
  const resultMessages = resultErrors(resultDetail);
  // Two copies of the failure text exist: the trace step's error and the
  // result's error. The browser-side trace error can be the bare "Expect
  // failed"; the result message is the runner's complete text (Expected /
  // Received / code frame / spec line). Keep the longer one.
  const traceError = failing.failingAction?.error ?? "";
  const bestError = [traceError, resultMessages[0] ?? ""].sort((a, b) => b.length - a.length)[0];
  const action = failing.failingAction
    ? { apiName: failing.failingAction.apiName, title: failing.failingAction.title, error: bestError }
    : resultMessages[0]
      ? { apiName: "test", title: summarizeErrorMessage(resultMessages[0]), error: resultMessages[0] }
      : null;
  const fromTest = failingTestOf(resultDetail);
  const fromTrace = failing.failingAction?.location ?? null;
  const loc = fromTest?.line ? { file: fromTest.file, line: fromTest.line, column: fromTest.column } : fromTrace ? { file: fromTrace.file.replace(/^.*[\\/](?=tests?[\\/]|[^\\/]+$)/, ""), line: fromTrace.line, column: fromTrace.column } : specLocation(bestError, null);
  const assertion = loc.line ? { file: loc.file, line: loc.line, column: loc.column ?? null, assertionId: assertionIdAtLine(sources, loc.file, loc.line) } : null;
  const origin = originOf(failing.baseURL) ?? originOf(failing.har.log.entries.find((e) => e._resourceType === "document")?.request.url ?? null);
  const candidates = failing.har.log.entries.filter((e) => {
    if (origin && originOf(e.request.url) !== origin) return false;
    const failed = e.response.status >= 400 || e.response.status <= 0 || !!e.response._failureText;
    return failed && isApiLike(e);
  });
  const last = candidates.at(-1) ?? null;
  let request: FailurePoint["request"] = null;
  if (last) {
    const key = `${last.request.method} ${pathOf(last.request.url).replace(/\?.*$/, "")}`;
    const twin = passing?.har.log.entries.find((e) => `${e.request.method} ${pathOf(e.request.url).replace(/\?.*$/, "")}` === key) ?? null;
    request = {
      method: last.request.method,
      url: last.request.url,
      path: pathOf(last.request.url),
      status: last.response.status,
      passingStatus: twin ? twin.response.status : null,
      failureText: last.response._failureText ?? null,
    };
  }
  if (!action && !request) return null;
  return { action, request, assertion };
}

/**
 * "Expected: X" / "Received: Y" as written by Playwright's expect (and by
 * Checkly's cleaned copy, which reads "Expected string: X"). Used to tell
 * whether an error group's first failure is the same failure as the captured
 * run — Checkly's grouping drops these values, so two different failures of
 * one assertion share a group.
 */
export function expectedReceived(text: string | null | undefined): { expected: string | null; received: string | null } {
  if (!text) return { expected: null, received: null };
  // Playwright prints one label per line; Checkly's cleaned copy joins the
  // lines with spaces. The value ends at the next label or at the line end.
  const value = (label: string): string | null => {
    const re = new RegExp(`(?:^|\\s)${label}(?: string| pattern| substring)?:\\s*([\\s\\S]*?)(?=\\s+(?:Expected|Received|Timeout|Locator|Call log|Error)(?: string| pattern| substring)?:|\\r?\\n|$)`, "i");
    const m = text.match(re);
    if (!m) return null;
    const v = m[1].trim().replace(/\s+/g, " ");
    return v.length ? v : null;
  };
  // No "Received:" when the locator matched nothing: Playwright prints
  // "Error: element(s) not found" (or "strict mode violation …") below Timeout.
  // That line is what the run received; the first "Error: expect(...) failed" is the header.
  const errorLines = [...text.matchAll(/(?:^|\s)Error:\s*([^\n]*?)(?=\s+(?:Expected|Received|Timeout|Locator|Call log|Error)(?: string| pattern| substring)?:|\r?\n|$)/gi)]
    .filter((m) => (m.index ?? 0) > 0) // the first line is the header ("Error: expect(...) failed", "Error: page.goto: …"), not the outcome
    .map((m) => m[1].trim().replace(/\s+/g, " "))
    .filter((v) => v.length && !/^expect\(/.test(v));
  return { expected: value("Expected"), received: value("Received") ?? errorLines[0] ?? null };
}

/** What the failing run received, from the first error that says so (Received: … or Error: element(s) not found). */
export function runOutcome(runErrors: string[]): { expected: string | null; received: string | null } {
  for (const e of runErrors) {
    const x = expectedReceived(e);
    if (x.received !== null) return x;
  }
  return { expected: expectedReceived(runErrors[0]).expected, received: null };
}

/** Everything Rocky wrote, as one string (root cause, impact, evidence, reconstructed step errors). */
export function rcaText(rca: RootCauseAnalysis | null | undefined): string {
  if (!rca) return "";
  const a = rca.analysis;
  return [a.rootCause, a.userImpact, ...(a.evidence ?? []).map((e) => e.description), ...(a.steps ?? []).flatMap((st) => [st.name, ...(st.errors ?? [])])].filter(Boolean).join("\n");
}

/**
 * Does Rocky's text mention what THIS run received? Rocky paraphrases (the
 * steps say "reported 401", not `Received: "401"`), so this is a normalized
 * substring test: `"401"` → 401, `<element(s) not found>` → element(s) not found.
 * null when the run has no "Received" line.
 */
export function rcaMentionsReceived(rca: RootCauseAnalysis | null | undefined, runErrors: string[]): boolean | null {
  const r = runOutcome(runErrors);
  if (!rca || r.received === null) return null;
  const needle = r.received.replace(/^["'<]+|[">']+$/g, "").trim().toLowerCase();
  if (!needle) return null;
  return rcaText(rca).toLowerCase().includes(needle);
}

/**
 * Is the group's RCA about an earlier, different failure? Two independent
 * signals; either one is enough:
 *  1. the group's first failure and this run received different things;
 *  2. the RCA predates this run and never mentions what this run received.
 */
export function rcaIsStale(x: { rca: RootCauseAnalysis | null; createdBefore: boolean | null; groupMatches: boolean | null; mentions: boolean | null }): boolean {
  if (!x.rca) return false;
  if (x.groupMatches === false) return true;
  return x.createdBefore === true && x.mentions === false;
}

/** Does the error group's first failure look like this run's failure? null when either side has no "Received". */
export function groupErrorMatches(groupMessage: string | null | undefined, runErrors: string[]): boolean | null {
  const g = expectedReceived(groupMessage);
  const r = runOutcome(runErrors);
  if (g.received === null || r.received === null) return null;
  return g.received === r.received && (g.expected === null || r.expected === null || g.expected === r.expected);
}

/**
 * Runs of the same check whose time window intersects the failing run's —
 * pure arithmetic on Checkly's own timestamps. An overlapping run from
 * another location is the direct evidence for a concurrency incident, and it
 * needs no interpretation of any text.
 */
export function findOverlappingRuns(failing: CheckResultSummary | null, history: CheckResultSummary[], fallbackDurationMs = 30_000): OverlappingRun[] {
  if (!failing) return [];
  const start = Date.parse(failing.startedAt);
  const stop = failing.stoppedAt ? Date.parse(failing.stoppedAt) : start + fallbackDurationMs;
  if (!Number.isFinite(start)) return [];
  const out: OverlappingRun[] = [];
  for (const r of history) {
    if (r.id === failing.id) continue;
    const s = Date.parse(r.startedAt);
    if (!Number.isFinite(s)) continue;
    const e = r.stoppedAt ? Date.parse(r.stoppedAt) : s + fallbackDurationMs;
    if (e < start || s > stop) continue;
    out.push({
      runId: r.id,
      runLocation: r.runLocation,
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt ?? null,
      startDeltaMs: start - s,
      overlapMs: r.stoppedAt || failing.stoppedAt ? Math.max(0, Math.min(stop, e) - Math.max(start, s)) : null,
      passed: !r.hasFailures && !r.hasErrors,
    });
  }
  return out.sort((a, b) => Math.abs(a.startDeltaMs) - Math.abs(b.startDeltaMs));
}

export function detectTargetResolution(check: ChecklyCheck, sources: Array<{ path: string; content: string }>): ManifestV3["target"]["resolution"] {
  const url = check.request?.url ?? "";
  if (/\{\{\s*ENVIRONMENT_URL\s*\}\}/.test(url)) return "handlebars";
  if (sources.some((s) => /ENVIRONMENT_URL/.test(s.content))) return "code";
  if (typeof check.script === "string" && /ENVIRONMENT_URL/.test(check.script)) return "code";
  return "unknown";
}

function buildInventory(sources: Array<{ path: string; content: string }>, mainSource: string | null): AssertionInventory | null {
  const specs = sources.filter((s) => s.path === mainSource || /\.(spec|test)\.[cm]?[jt]sx?$/.test(s.path));
  if (specs.length === 0) return null;
  const merged: AssertionInventory = { checkFile: mainSource ?? specs[0].path, assertions: [], steps: [], totalAssertions: 0 };
  const seen = new Set<string>();
  for (const s of specs) {
    const inv = parseInventory(s.path, s.content);
    for (const a of inv.assertions) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      merged.assertions.push(a);
    }
    merged.steps.push(...inv.steps.map((st) => (specs.length > 1 ? `${s.path}:${st}` : st)));
  }
  merged.totalAssertions = merged.assertions.length;
  return merged;
}

/** Assertion ids whose matcher/target matches the failing expect() call. */
function assertionsForFailure(inv: AssertionInventory | null, fp: FailurePoint | null): string[] {
  if (!inv) return [];
  const all = inv.assertions.map((a) => a.id);
  if (fp?.assertion?.assertionId) return [fp.assertion.assertionId];
  const action = fp?.action;
  if (!action) return all;
  const m = /^expect\.(\w+)/.exec(action.apiName);
  const matcher = m?.[1];
  const expected = /expected=("(?:[^"\\]|\\.)*")/.exec(action.title)?.[1];
  const hits = inv.assertions.filter((a) => (!matcher || a.matcher === matcher) && (!expected || a.target === expected || a.target === expected.replace(/"/g, "'")));
  return hits.length ? hits.map((a) => a.id) : all;
}

function historyStats(history: CheckResultSummary[]): DeterminismV3["history"] {
  const finals = history.filter((r) => (r.resultType ?? "FINAL") === "FINAL");
  const byLocation: Record<string, { runs: number; passed: number }> = {};
  let passed = 0;
  for (const r of finals) {
    const ok = !r.hasFailures && !r.hasErrors;
    if (ok) passed += 1;
    const loc = (byLocation[r.runLocation] ??= { runs: 0, passed: 0 });
    loc.runs += 1;
    if (ok) loc.passed += 1;
  }
  const times = finals.map((r) => r.startedAt).sort();
  return {
    window: history.length,
    finalRuns: finals.length,
    passed,
    failed: finals.length - passed,
    passRate: finals.length ? Number((passed / finals.length).toFixed(3)) : null,
    byLocation,
    from: times[0] ?? null,
    to: times.at(-1) ?? null,
  };
}

export function buildManifest(input: ManifestInputs): ManifestV3 {
  const { check, failing, passing, rca, errorGroup } = input;
  const notes: string[] = [];
  const envVars = envVarNamesOnly(check.environmentVariables);
  const locations = check.locations ?? [];
  const runParallel = Boolean(check.runParallel);
  const inventory = buildInventory(input.sources, input.mainSource);
  const failurePoint = detectFailurePoint(failing?.extract ?? null, passing?.extract ?? null, failing?.detail ?? null, input.sources);
  const resolution = detectTargetResolution(check, input.sources);
  const recordedOrigin =
    originOf(failing?.extract?.baseURL ?? passing?.extract?.baseURL ?? null) ??
    originOf((failing ?? passing)?.extract?.har.log.entries.find((e) => e._resourceType === "document")?.request.url ?? null);

  // ---- reproduction mode: data first, text second ----
  // 1. result timestamps: another location ran at the same time → concurrency
  // 2. RCA / error-group text through the fixed rule table
  // 3. nothing matched → both (live-concurrent first, replay as alternative)
  const overlappingRuns = findOverlappingRuns(failing?.summary ?? null, input.history);
  // Only a sibling that PASSED while this run failed is evidence of a
  // concurrency/state incident (one copy won, the other lost). With
  // runParallel every run has a sibling; when the sibling failed too, the
  // failure does not depend on which copy wins — the overlap decides nothing.
  const siblingRuns = overlappingRuns.filter((o) => o.runLocation !== failing?.summary.runLocation);
  const otherLocationOverlap = siblingRuns.filter((o) => o.passed);
  const failedSiblings = siblingRuns.filter((o) => !o.passed);
  const rcaText = rca ? `${rca.analysis.classification}\n${rca.analysis.rootCause}\n${rca.analysis.userImpact}` : errorGroup?.cleanedErrorMessage ?? null;
  const textCls = classifyRca(rcaText);
  let cls: { mode: ReturnType<typeof classifyRca>["mode"]; matchedRule: string | null; matchedText: string | null };
  let decidedBy: ManifestV3["reproduction"]["decidedBy"];
  let reproductionReason: string;
  if (!failing) {
    cls = { mode: "both", matchedRule: null, matchedText: null };
    decidedBy = "none";
    reproductionReason = "no failing result yet → reproduction mode undecided (both)";
  } else if (otherLocationOverlap.length) {
    const o = otherLocationOverlap[0];
    const when = o.startDeltaMs >= 0 ? `${(o.startDeltaMs / 1000).toFixed(1)} s before` : `${(-o.startDeltaMs / 1000).toFixed(1)} s after`;
    cls = { mode: "live-concurrent:2", matchedRule: "overlapping-run", matchedText: `${o.runId} @ ${o.runLocation}` };
    decidedBy = "result-timestamps";
    reproductionReason = `run ${o.runId} from ${o.runLocation} started ${when} the failing run and overlapped it${o.overlapMs !== null ? ` for ${(o.overlapMs / 1000).toFixed(1)} s` : ""} (it ${o.passed ? "passed" : "failed"})${runParallel ? "; the check has runParallel: true" : ""} → live-concurrent:2`;
    if (textCls.matchedRule && textCls.mode !== "live-concurrent:2") {
      notes.push(`RCA text suggested ${textCls.mode} (rule "${textCls.matchedRule}") but the result timestamps show an overlapping run from another location; the tool follows the timestamps`);
    } else if (rca && !textCls.matchedRule) {
      notes.push(`Rocky classified the failure as ${rca.analysis.classification}${rca.analysis.repairRecommendation ? ` (${rca.analysis.repairRecommendation})` : ""}; the result timestamps show an overlapping run from another location, which the RCA text does not name — the tool follows the timestamps`);
    }
  } else {
    cls = textCls;
    decidedBy = textCls.matchedRule ? (rca ? "rca-text" : "error-group-text") : "none";
    if (failedSiblings.length) {
      notes.push(`${failedSiblings.map((o) => `${o.runId} @ ${o.runLocation}`).join(", ")} overlapped the failing run and failed too — the failure does not depend on which copy wins, so the overlap is not evidence of concurrency`);
    }
    reproductionReason = rca
      ? textCls.matchedRule
        ? `RCA text matched rule "${textCls.matchedRule}" ("${textCls.matchedText}") → ${textCls.mode}`
        : `RCA text matched no rule and no passing overlapping run was found${failedSiblings.length ? " (the overlapping run failed too)" : ""} → both modes; the scene is UNCERTAIN if neither reproduces`
      : errorGroup
        ? textCls.matchedRule
          ? `no RCA; error-group message matched rule "${textCls.matchedRule}" → ${textCls.mode}`
          : "no RCA, no rule matched, no overlapping run → both modes"
        : "no RCA and no error group → both modes";
  }

  // ---- env assumptions (facts from the check config, all verifiable) ----
  const envAssumptions: ManifestV3["envAssumptions"] = [];
  envAssumptions.push({
    id: "locations",
    text: `the check runs from ${locations.length} location(s): ${locations.join(", ") || "none"}`,
    verified: true,
    verifiedBy: "checkly:GET /v1/checks",
  });
  if (runParallel && locations.length > 1) {
    envAssumptions.push({
      id: "run-parallel",
      text: "all locations run at the same moment (runParallel: true) — overlapping runs are normal",
      verified: true,
      verifiedBy: "checkly:GET /v1/checks",
    });
  }
  if (envVars.length) {
    envAssumptions.push({
      id: "env-vars",
      text: `the check reads environment variables: ${envVars.map((v) => v.key + (v.secret ? " (secret)" : "")).join(", ")} — names only, values stay in Checkly`,
      verified: true,
      verifiedBy: "checkly:GET /v1/checks",
    });
    const accountVar = envVars.find((v) => /(user|account|login|email|username)/i.test(v.key));
    if (accountVar && locations.length > 1) {
      envAssumptions.push({
        id: "shared-account",
        text: `every location uses the same ${accountVar.key} value (check-level variable) — one shared test account`,
        verified: true,
        verifiedBy: "checkly:GET /v1/checks",
      });
    }
  }
  envAssumptions.push({
    id: "target-resolution",
    text:
      resolution === "code"
        ? "the check reads process.env.ENVIRONMENT_URL, so `verify --target` can point it at another environment"
        : resolution === "handlebars"
          ? "the API check URL uses {{ENVIRONMENT_URL}} (no fallback): the variable must be set for every target"
          : "the check does not read ENVIRONMENT_URL: it can only run against the URL baked into its code",
    verified: true,
    verifiedBy: "verify-fix:source-scan",
  });
  if (recordedOrigin) {
    envAssumptions.push({ id: "recorded-origin", text: `recorded runs hit ${recordedOrigin}`, verified: true, verifiedBy: "playwright-trace" });
  }
  if (siblingRuns.length) {
    envAssumptions.push({
      id: "overlapping-run",
      text: `the failing run overlapped in time with ${siblingRuns.map((o) => `${o.runId} (${o.runLocation}, ${o.passed ? "passed" : "failed"})`).join(", ")}`,
      verified: true,
      verifiedBy: "checkly:GET /v2/check-results (startedAt/stoppedAt)",
    });
  }

  // ---- is the RCA about THIS failure? ----
  const failingErrorsForRca = resultErrors(failing?.detail ?? null);
  const rcaCreatedBefore = rca && failing ? Date.parse(rca.created_at) < Date.parse(failing.summary.startedAt) : null;
  const groupMatches = errorGroup && failing ? groupErrorMatches(errorGroup.cleanedErrorMessage, failingErrorsForRca) : null;
  const rcaMentions = rca && failing ? rcaMentionsReceived(rca, failingErrorsForRca) : null;
  const rcaStale = rcaIsStale({ rca, createdBefore: rcaCreatedBefore, groupMatches, mentions: rcaMentions });
  if (rca && failing && rcaStale) {
    const g = expectedReceived(errorGroup?.cleanedErrorMessage);
    const r = runOutcome(failingErrorsForRca);
    const why =
      groupMatches === false
        ? `error group ${errorGroup!.id} merges different failures: its first failure received ${g.received}, the captured run received ${r.received}`
        : `RCA ${rca.id} never mentions what the captured run received (${r.received}) and was created ${rca.created_at}, before this run`;
    notes.push(
      `${why}. Rocky analyzes only the first failure of a group, so this RCA describes an earlier failure, not this one` +
        (input.replacedRca ? "" : " — pass --trigger-rca to request a fresh analysis"),
    );
  }
  if (input.replacedRca && rca) {
    notes.push(`RCA ${rca.id} was requested by verify-fix bundle (--trigger-rca) because the group's earlier RCA ${input.replacedRca.id} (${input.replacedRca.analysis.classification}) described a different failure; both are kept in rca.json`);
  }

  // ---- scenes ----
  const scenes: SceneV3[] = [];
  const failingId = failing?.summary.id ?? null;
  const passingId = passing?.summary.id ?? null;
  const lastAssertion = inventory?.assertions.at(-1)?.id ?? null;
  const allAssertionIds = inventory?.assertions.map((a) => a.id) ?? [];
  const failureAssertions = assertionsForFailure(inventory, failurePoint);

  if (passingId) {
    scenes.push({
      sceneId: "healthy-live",
      type: "HEALTHY",
      mode: "live",
      state: `the target behaves as in the last passing run (${passingId}, ${passing!.summary.runLocation}); the fixed check must pass`,
      verdict: { mustFail: false, provenance: { kind: "recorded", runId: passingId, artifactId: "recordings/passing.har" }, envAssumptions: ["locations", "target-resolution"] },
      experiments: [{ durationSec: 60, repetitions: REPS, expectStable: true }],
      assertionsInvolved: allAssertionIds,
      environment: "target",
    });
  } else if (lastAssertion) {
    scenes.push({
      sceneId: "healthy-live",
      type: "HEALTHY",
      mode: "live",
      state: "no passing run recorded yet; the fixed check must pass on the target as written",
      verdict: { mustFail: false, provenance: { kind: "code", assertionId: lastAssertion }, envAssumptions: ["locations", "target-resolution"] },
      experiments: [{ durationSec: 60, repetitions: REPS, expectStable: true }],
      assertionsInvolved: allAssertionIds,
      environment: "target",
      notes: ["provenance is code-derived because Checkly has no passing result for this check yet"],
    });
  }

  if (failingId) {
    const mode = cls.mode === "both" ? "live-concurrent:2" : cls.mode;
    const alt = cls.mode === "both" ? "replay:failing.har" : undefined;
    scenes.push({
      sceneId: "reproduction",
      type: "REPRODUCTION",
      mode,
      ...(alt ? { alternativeMode: alt } : {}),
      state:
        mode === "live-concurrent:2"
          ? `two copies of the check run at once on the target, as the overlapping locations did in the failing run${otherLocationOverlap.length ? ` (${failing!.summary.runLocation} + ${otherLocationOverlap[0].runLocation})` : ""}; the fixed check must pass`
          : "the responses of the failing run are replayed from recordings/failing.har; the fixed check must pass against them",
      verdict: {
        mustFail: false,
        provenance: { kind: "recorded", runId: failingId, artifactId: "recordings/failing.har" },
        // "overlapping-run" is the scene's evidence only when a sibling passed
        envAssumptions: ["locations", "run-parallel", "shared-account", ...(otherLocationOverlap.length ? ["overlapping-run"] : [])].filter((id) => envAssumptions.some((a) => a.id === id)),
      },
      experiments: [{ durationSec: 120, repetitions: REPS, expectStable: true }],
      assertionsInvolved: failureAssertions,
      environment: mode === "live-concurrent:2" ? "target" : "recording",
      notes: [reproductionReason],
    });

    const req = failurePoint?.request;
    const injectRule = req ? `inject:${req.method} ${req.path.replace(/\?.*$/, "")} -> ${req.status}` : "inject:<failing request unknown>";
    scenes.push({
      sceneId: "detection",
      type: "DETECTION",
      mode: injectRule as SceneV3["mode"],
      state: req
        ? `the failing response (${req.method} ${req.path.replace(/\?.*$/, "")} → ${req.status}) is injected on top of a live run; the fixed check MUST still fail (it may not hide the incident)`
        : "the recorded failure is injected on top of a live run; the fixed check must still fail",
      verdict: { mustFail: true, provenance: { kind: "recorded", runId: failingId, artifactId: "recordings/failing.har" }, envAssumptions: ["target-resolution"] },
      experiments: [{ durationSec: 60, repetitions: REPS, expectStable: true }],
      assertionsInvolved: failureAssertions,
      environment: "target+recording",
      ...(req ? {} : { notes: ["no failing API request could be identified in the trace; the scene layer must derive the injection from the failing action"] }),
    });
  } else {
    notes.push("no failing result found for this check: REPRODUCTION and DETECTION scenes are absent until an incident is captured (re-run `verify-fix bundle` after a failure)");
  }
  notes.push("REGRESSION scenes (sibling checks) are not generated yet — planned once group listing is wired (Phase 3)");

  const recorded = scenes.filter((s) => s.verdict.provenance.kind === "recorded").length;
  const codeDerived = scenes.length - recorded;

  const measurement = input.measurement;
  const determinism: DeterminismV3 = {
    measured: Boolean(measurement && (measurement.sequential.runs > 0 || measurement.overlap.pairs > 0)),
    history: historyStats(input.history),
    sequential: measurement && measurement.sequential.runs > 0 ? measurement.sequential : null,
    overlap: measurement && measurement.overlap.pairs > 0 ? measurement.overlap : null,
    lastVerifiedAt: input.now,
  };

  const primaryFile = input.mainSource ?? input.sources[0]?.path ?? null;
  const failingErrors = resultErrors(failing?.detail ?? null);
  const incidentSlug = (input.project.logicalId ?? check.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  // Stable across re-captures of the same failure. When Checkly filed a
  // different failure under an existing group (its Received differs), the
  // run's Received joins the key so the two incidents do not share an id.
  const runReceived = runOutcome(resultErrors(failing?.detail ?? null)).received;
  const groupKey = errorGroup ? (groupErrorMatches(errorGroup.cleanedErrorMessage, resultErrors(failing?.detail ?? null)) === false && runReceived ? `${errorGroup.id}|${runReceived}` : errorGroup.id) : null;
  const incidentId = failingId ? `${incidentSlug}-${fnv1a(groupKey ?? failingId).slice(0, 6)}` : `${incidentSlug}-baseline`;

  return {
    schemaVersion: "v3",
    generatedBy: `verify-fix bundle ${input.toolVersion}`,
    generatedAt: input.now,
    incidentId,
    incident: {
      title: failingId
        ? `${check.name}: ${summarizeErrorMessage(failingErrors[0] ?? errorGroup?.cleanedErrorMessage ?? failurePoint?.action?.error ?? failurePoint?.action?.apiName ?? "check failed")}`
        : `${check.name}: baseline (no failure recorded)`,
      description: failingId
        ? [failingErrors[0] ?? errorGroup?.cleanedErrorMessage, failurePoint?.request ? `Network: ${failurePoint.request.method} ${failurePoint.request.path} → ${failurePoint.request.status}${failurePoint.request.passingStatus !== null ? ` (passing run: ${failurePoint.request.passingStatus})` : ""}` : null, rca ? `Rocky RCA (${rca.analysis.classification}): ${rca.analysis.rootCause}` : null]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 4000)
        : "Bundle of a healthy check. Contains the last passing run and the check's configuration; no incident yet.",
      sourceReference: failingId ? `checkly:check-result:${check.id}/${failingId}` : passingId ? `checkly:check-result:${check.id}/${passingId}` : null,
      status: failingId ? "captured" : "no-failure-yet",
    },
    check: {
      id: check.id,
      name: check.name,
      checkType: check.checkType,
      repo: input.project.repoUrl,
      file: primaryFile,
      files: input.sources.map((s) => s.path),
      logicalId: input.project.logicalId,
      deployedId: check.id,
      projectCommit: input.project.gitCommit,
    },
    config: {
      frequencyMinutes: check.frequency ?? null,
      locations,
      privateLocations: check.privateLocations ?? [],
      runParallel,
      retryStrategy: (check.retryStrategy as Record<string, unknown> | null | undefined) ?? null,
      doubleCheck: typeof check.doubleCheck === "boolean" ? check.doubleCheck : null,
      activated: Boolean(check.activated),
      muted: Boolean(check.muted),
      tags: check.tags ?? [],
      runtimeId: check.runtimeId ?? null,
      environmentVariables: envVars,
      repair: {
        intent: check.intent?.goal
          ? { goal: check.intent.goal, requiredOutcomes: check.intent.requiredOutcomes ?? [], mustPreserve: check.intent.mustPreserve ?? [] }
          : null,
        aiAutoRepairEnabled: typeof check.aiAutoRepairEnabled === "boolean" ? check.aiAutoRepairEnabled : null,
      },
      playwright:
        check.checkType === "PLAYWRIGHT"
          ? {
              configPath: check.playwrightConfigPath ?? input.project.playwright?.configPath ?? null,
              projects: check.pwProjects?.length ? check.pwProjects : (input.project.playwright?.projects ?? []),
              tags: check.pwTags?.length ? check.pwTags : (input.project.playwright?.tags ?? []),
              version: check.playwrightVersion ?? null,
              source: check.playwrightConfigPath || check.pwProjects?.length ? "api" : input.project.playwright?.configPath ? "project" : null,
            }
          : null,
      apiRequest:
        check.checkType === "API" || check.checkType === "URL"
          ? { method: check.request?.method ?? null, url: check.request?.url ?? null, assertions: check.request?.assertions ?? [] }
          : null,
    },
    target: {
      resolution,
      variable: "ENVIRONMENT_URL",
      recordedOrigin,
      note:
        resolution === "unknown"
          ? "verify --target cannot redirect this check; scenes will run against the recorded origin only"
          : "verify --target sets ENVIRONMENT_URL/ENVIRONMENT_NAME for every live scene (Checkly's own convention)",
    },
    results: { failing: toRef(failing), passing: toRef(passing) },
    rca: rca
      ? {
          id: rca.id,
          createdAt: rca.created_at,
          createdBeforeFailingRun: rcaCreatedBefore,
          groupErrorMatchesFailingRun: groupMatches,
          mentionsFailingRunReceived: rcaMentions,
          describesFailingRun: !rcaStale,
          replaced: input.replacedRca ? { id: input.replacedRca.id, createdAt: input.replacedRca.created_at, classification: input.replacedRca.analysis.classification } : null,
          classification: rca.analysis.classification,
          rootCause: rca.analysis.rootCause,
          userImpact: rca.analysis.userImpact,
          codeFix: rca.analysis.codeFix,
          evidence: (rca.analysis.evidence ?? []).map((e) => ({ description: e.description, artifacts: e.artifacts ?? [] })),
          repairRecommendation: rca.analysis.repairRecommendation ?? null,
          provider: rca.provider,
          model: rca.model,
        }
      : null,
    errorGroup: errorGroup
      ? { id: errorGroup.id, cleanedErrorMessage: errorGroup.cleanedErrorMessage, firstSeen: errorGroup.firstSeen, lastSeen: errorGroup.lastSeen }
      : null,
    reproduction: { mode: cls.mode, matchedRule: cls.matchedRule, matchedText: cls.matchedText, reason: reproductionReason, decidedBy, overlappingRuns },
    failurePoint,
    recordings: input.recordings,
    scenes,
    assertions: inventory,
    envAssumptions,
    determinism,
    runBudget: { maxPerScene: 10, used: 0 },
    oracleProvenance: { recorded, codeDerived },
    provenance: {
      accountIdHash: fnv1a(input.accountId),
      checkId: check.id,
      failingResultId: failingId,
      passingResultId: passingId,
      errorGroupId: errorGroup?.id ?? null,
      rcaId: rca?.id ?? null,
      assets: input.assets,
      apiCalls: input.apiCalls,
    },
    notes,
  };
}
