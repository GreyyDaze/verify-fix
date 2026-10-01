// Remote-only finalization and offline re-binding. A local --assets draft is
// deliberately not a v3 recording; never upgrade it by assigning a field.
import { createHash } from "node:crypto";
import type { CheckResultSummary } from "../checkly/types.ts";
import type { ManifestV3, FailurePoint } from "../bundle/types.ts";
import { assertionId } from "../assertion/id.ts";
import { MULTISTEP_RECORDING_SCHEMA, type MultiStepRecording, type MultiStepRecordingDraft,
  type MultiStepFailureAssertion } from "./capture.ts";
import { validMultiStepStoredRecording } from "./recording-schema.ts";
import { multiStepShapeProblems } from "./shape.ts";
import type { MultiStepSourceModel } from "./source.ts";

export type RemoteAssetProof = ManifestV3["provenance"]["assets"][number];
export function digestBytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function boundFailureAssertion(steps: MultiStepRecording["steps"],
  source: Pick<MultiStepSourceModel, "script" | "errors"> | null, file: string,
  reporterOnly = false): MultiStepFailureAssertion | null {
  if (source?.errors.length || !source?.script || source.script.file !== file
    || file.split("/").at(-1) !== "multistep-booking.spec.ts") return null;
  const book = steps[3];
  if (!book || book.title !== "book 09:30" || book.status !== "failed" || book.error !== "ASSERTION_FAILED"
    || !Number.isSafeInteger(book.failureLine) || (book.failureLine ?? 0) < 1
    || (reporterOnly && book.requests.length === 0 ? false
      : book.requests.length !== 1 || book.requests[0]!.method !== "POST"
        || book.requests[0]!.path !== "/api/book" || book.requests[0]!.status !== 200)
    || (reporterOnly && book.assertions.length === 0 ? false
      : !book.assertions.some((a) => a.expected === true && a.actual !== true && a.passed !== true))) return null;
  const onLine = source.script.assertions.filter((a) => a.sourceLine === book.failureLine && a.stepTitle === book.title);
  // Exact source-coordinate match first — the local reporter always reports
  // the source line, and a stored recording was already re-based to it.
  const assertion = onLine[0];
  if (onLine.length === 1 && assertion) {
    if (assertion.subject !== "body.confirmed" || assertion.matcher !== "toBe"
      || assertion.target !== "true" || assertion.negated
      || assertion.id !== assertionId("body.confirmed", "toBe", "true")) return null;
    return { step: "book 09:30", line: assertion.sourceLine, id: assertion.id, subject: "body.confirmed",
      repairedSubject: "body.booking.confirmed", matcher: "toBe", target: "true", negated: false };
  }
  if (onLine.length > 0 || reporterOnly) return null;
  // Checkly 9.5.0 runtime coordinates: the scheduled runner reports the
  // failing expect in its own transpiled/VM-wrapped file (verified against a
  // real scheduled result: reported 132 for source line 142 of the SAME
  // byte-identical deployed script), so the reported line can match no
  // source assertion. The binding then falls back to the step's UNIQUE
  // source assertion with the exact failing expectation: exactly one
  // unnegated toBe(true) in the failing step, corroborated by the
  // reporter's own expected=true / not-true / definitely-failed evidence.
  // Any reported line that lands on a different source assertion is still
  // rejected above; nothing here loosens the stale-assertion identity.
  if (!book.assertions.some((a) => a.expected === true && a.actual !== true && a.passed === false)) return null;
  const candidates = source.script.assertions.filter((a) => a.stepTitle === book.title
    && a.matcher === "toBe" && a.target === "true" && !a.negated);
  const stale = candidates[0];
  if (candidates.length !== 1 || !stale || stale.subject !== "body.confirmed"
    || stale.id !== assertionId("body.confirmed", "toBe", "true")) return null;
  return { step: "book 09:30", line: stale.sourceLine, id: stale.id, subject: "body.confirmed",
    repairedSubject: "body.booking.confirmed", matcher: "toBe", target: "true", negated: false };
}

/** Local detection only: the ORIGINAL remote binding must already have been
 * revalidated separately. Require the candidate's hard, unnegated repaired
 * assertion at the reporter's exact failure line. The original v3 admission
 * function above continues to require body.confirmed and a nested true body. */
export function boundDetectionFailureAssertion(steps: MultiStepRecording["steps"],
  source: Pick<MultiStepSourceModel, "script" | "errors"> | null, file: string,
  protectedFailure: MultiStepFailureAssertion): boolean {
  if (source?.errors.length || !source?.script || source.script.file !== file
    || file.split("/").at(-1) !== "multistep-booking.spec.ts"
    || protectedFailure.subject !== "body.confirmed" || protectedFailure.repairedSubject !== "body.booking.confirmed"
    || protectedFailure.step !== "book 09:30" || protectedFailure.negated
    || protectedFailure.matcher !== "toBe" || protectedFailure.target !== "true"
    || protectedFailure.id !== assertionId("body.confirmed", "toBe", "true")) return false;
  const book = steps[3];
  if (steps.length !== 4 || !book || book.title !== "book 09:30" || book.status !== "failed"
    || book.error !== "ASSERTION_FAILED" || !Number.isSafeInteger(book.failureLine) || (book.failureLine ?? 0) < 1
    || (book.requests.length !== 0 && (book.requests.length !== 1 || book.requests[0]!.method !== "POST"
      || book.requests[0]!.path !== "/api/book" || book.requests[0]!.status !== 200))
    || (book.assertions.length !== 0 && !book.assertions.some((a) => a.expected === true
      && a.actual !== true && a.passed !== true))) return false;
  const onLine = source.script.assertions.filter((a) => a.sourceLine === book.failureLine && a.stepTitle === book.title);
  const assertion = onLine[0];
  return onLine.length === 1 && Boolean(assertion && assertion.subject === protectedFailure.repairedSubject
    && assertion.matcher === protectedFailure.matcher && assertion.target === protectedFailure.target
    && !assertion.negated && assertion.id === protectedFailure.id);
}

export interface RemoteBindingContext {
  side: "failing" | "passing";
  checkId: string;
  result: Pick<CheckResultSummary, "id" | "checkId" | "runLocation" | "startedAt" | "stoppedAt" | "hasFailures" | "hasErrors" | "resultType">;
  /** Authenticated detail of the selected run, not an unrelated history row. */
  detail: Pick<CheckResultSummary, "id" | "checkId" | "runLocation" | "startedAt" | "stoppedAt" | "hasFailures" | "hasErrors" | "resultType"> | null;
  sourceFile: string;
  sourceText: string;
  sourceModel: MultiStepSourceModel | null;
  asset: RemoteAssetProof;
}

/** Construct a NEW v3 object only with validated authenticated remote inputs. */
export function finalizeRemoteMultiStepRecording(draft: MultiStepRecordingDraft,
  ctx: RemoteBindingContext): MultiStepRecording | null {
  const { result, detail, asset, side } = ctx;
  const final = result.resultType === "FINAL" && detail?.resultType === "FINAL"
    && result.checkId === ctx.checkId && detail.checkId === ctx.checkId
    && detail.id === result.id && detail.runLocation === result.runLocation && detail.startedAt === result.startedAt
    && detail.stoppedAt === result.stoppedAt && detail.hasFailures === result.hasFailures
    && detail.hasErrors === result.hasErrors && result.hasErrors === false
    && (side === "failing" ? result.hasFailures === true : result.hasFailures === false);
  if (!final || draft.kind !== side || multiStepShapeProblems(draft).length
    || !result.stoppedAt || !Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.stoppedAt))
    || !ctx.sourceModel?.script || ctx.sourceModel.errors.length || ctx.sourceModel.script.file !== ctx.sourceFile
    || asset.result !== side || asset.name !== "test-results.json" || asset.type !== "remote-asset"
    || asset.resultId !== result.id || (asset.assetType !== "report" && asset.assetType !== "file")
    || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[a-f0-9]{64}$/.test(asset.manifestEntrySha256 ?? "")
    || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) return null;
  const failure = side === "failing" ? boundFailureAssertion(draft.steps, ctx.sourceModel, ctx.sourceFile) : null;
  if (side === "failing" && !failure) return null;
  // A reported runtime line that matched no source assertion was re-based by
  // the fallback above: stored steps carry SOURCE coordinates so the offline
  // binding check replays the exact-line rule unchanged.
  const steps = side === "failing" && failure !== null && draft.steps[3]?.failureLine !== failure.line
    ? draft.steps.map((step, index) => index === 3 ? { ...step, failureLine: failure.line } : step)
    : draft.steps;
  const recording: MultiStepRecording = {
    schemaVersion: MULTISTEP_RECORDING_SCHEMA,
    binding: {
      side, checkId: ctx.checkId, resultId: result.id, runLocation: result.runLocation,
      startedAt: result.startedAt, stoppedAt: result.stoppedAt, sourceFile: ctx.sourceFile,
      sourceSha256: digestBytes(ctx.sourceText), testResultsSha256: asset.sha256,
      testResultsBytes: asset.bytes, assetManifestSha256: asset.manifestEntrySha256!, assetType: asset.assetType,
      reporter: "playwright-json-nested", bridge: "required-at-local-execution", failureAssertion: failure,
    },
    kind: draft.kind, stats: draft.stats, reporterStatus: draft.reporterStatus, reporterErrors: draft.reporterErrors, steps, checkRunData: draft.checkRunData,
    logs: draft.logs, recurrence: draft.recurrence, transaction: draft.transaction,
    problems: draft.problems, evidenceNote: draft.evidenceNote,
  };
  return validMultiStepStoredRecording(recording, side) ? recording : null;
}

export function matchesRemoteMultiStepBinding(record: MultiStepRecording, ctx: Omit<RemoteBindingContext, "detail" | "result"> & {
  result: { id: string; runLocation: string; startedAt: string; stoppedAt: string | null };
}): boolean {
  const b = record.binding;
  const { asset, result, side } = ctx;
  const failure = side === "failing" ? boundFailureAssertion(record.steps, ctx.sourceModel, ctx.sourceFile) : null;
  return validMultiStepStoredRecording(record, side) && (side !== "failing" || failure !== null)
    && JSON.stringify(b.failureAssertion) === JSON.stringify(failure)
    && b.side === side && b.checkId === ctx.checkId && b.resultId === result.id
    && b.runLocation === result.runLocation && b.startedAt === result.startedAt && b.stoppedAt === result.stoppedAt
    && b.sourceFile === ctx.sourceFile && b.sourceSha256 === digestBytes(ctx.sourceText)
    && asset.result === side && asset.name === "test-results.json" && asset.type === "remote-asset"
    && asset.resultId === result.id && asset.assetType === b.assetType
    && asset.sha256 === b.testResultsSha256 && asset.bytes === b.testResultsBytes
    && asset.manifestEntrySha256 === b.assetManifestSha256;
}

/** The only Multistep failure point: a measured status-200 book followed by
 * the uniquely source-bound stale assertion. Timing is UNKNOWN, not zero. */
export function failurePointFromRecording(record: MultiStepRecording, file: string): FailurePoint | null {
  const b = record.binding;
  const fail = b.failureAssertion;
  if (record.kind !== "failing" || !fail || b.sourceFile !== file || record.steps[3]?.requests[0]?.status !== 200) return null;
  return {
    action: { apiName: "test.step", title: fail.step, error: "ASSERTION_FAILED" },
    request: null,
    assertion: { file, line: fail.line, column: null, assertionId: fail.id },
    dependency: { method: "POST", url: "https://recorded.invalid/api/book", path: "/api/book",
      passingStatus: null, msBeforeStep: null, stepLine: fail.line, stepTitle: fail.step },
  };
}
