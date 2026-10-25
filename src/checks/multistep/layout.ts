// Derive the route/step layout from a capture. Capture-time validation has no
// bundle scenario yet, so it uses the recording's own ordered structure. This
// is not trust: the stored bundle still binds the recording to the source,
// asset and result, and the bundle scenario is revalidated on load.
import type { MultistepEvidenceScenario } from "../../types.ts";
import type { MultiStepCapture } from "./normalize.ts";

function slotOf(value: unknown, depth = 0): string | null {
  if (depth > 12) return null;
  if (typeof value === "string") return /^\d{2}:\d{2}$/.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = slotOf(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = slotOf(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function scenarioLayout(capture: Pick<MultiStepCapture, "steps">): MultistepEvidenceScenario {
  const routes: MultistepEvidenceScenario["routes"] = [];
  for (const step of capture.steps) {
    for (const request of step.requests) {
      if (!request.method || !request.path) continue;
      routes.push({
        method: request.method,
        path: request.path,
        step: step.title,
        ...(request.requestHeaders.authorization !== undefined ? { auth: true } : {}),
      });
    }
  }
  let slot: string | undefined;
  for (const step of capture.steps) {
    for (const request of step.requests) {
      slot ??= slotOf(request.requestBody) ?? slotOf(request.responseBody) ?? undefined;
    }
  }
  return {
    routes,
    stepTitles: capture.steps.map((step) => step.title),
    ...(slot ? { slot } : {}),
  };
}

/** Layout of the check as written, used by direct adapter runs that have no
 * bundle scenario yet. Structural only: the canonical gate and bridge/reporter
 * comparison still decide whether that layout is the one that executed. */
export function sourceLayout(input: {
  steps: Array<{ title: string }>;
  requests: Array<{ stepTitle: string | null; method: string; route: string | null; usesBearer?: boolean }>;
}): MultistepEvidenceScenario {
  return {
    routes: input.requests.filter((request) => request.route !== null).map((request) => ({
      method: request.method, path: request.route!, step: request.stepTitle ?? "",
      ...(request.usesBearer ? { auth: true } : {}),
    })),
    stepTitles: input.steps.map((step) => step.title),
  };
}
