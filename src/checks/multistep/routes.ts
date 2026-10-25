// Bundle-supplied Multistep route and step helpers.
//
// No route, method or step title is hardcoded here. Everything comes from the
// validated `scenario` block in the trusted bundle manifest. A recording,
// reporter payload, archive, error message or candidate file can never add a
// route or step: unknown values are explicitly unjudgeable, not approximated.
import type { MultistepEvidenceScenario, MultistepScenarioRoute } from "../../types.ts";

export type MultiStepRoute = string;
export type MultiStepStepTitle = string;
export const UNKNOWN_ROUTE = "<unknown-route>";

/** A syntactically canonical pathname: absolute, no query/fragment/dot segments. */
export function canonicalPath(text: string | null | undefined): string | null {
  if (typeof text !== "string" || text.length < 1 || text.length > 1024) return null;
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(text) || text.startsWith("//")) return null;
  if (text.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return text;
}

export function routeAt(scenario: MultistepEvidenceScenario, index: number): MultistepScenarioRoute | null {
  return scenario.routes[index] ?? null;
}

export function knownRoute(scenario: MultistepEvidenceScenario, path: string | null | undefined): MultiStepRoute | null {
  if (typeof path !== "string") return null;
  const route = scenario.routes.find((entry) => entry.path === path);
  return route ? route.path : null;
}

export function routeFromUrl(scenario: MultistepEvidenceScenario, url: string | null | undefined): MultiStepRoute | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      ? knownRoute(scenario, parsed.pathname) : null;
  } catch {
    return null;
  }
}

export function knownStepTitle(scenario: MultistepEvidenceScenario, title: string | null | undefined): MultiStepStepTitle | null {
  return typeof title === "string" && scenario.stepTitles.includes(title) ? title : null;
}

/** Titles of the request steps, in route order. */
export function requestStepTitles(scenario: MultistepEvidenceScenario): string[] {
  return scenario.routes.map((route) => route.step);
}
