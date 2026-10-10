// The captured Multistep transaction has four public, fixed API routes. No
// caller may persist a path segment or query name supplied by a result,
// reporter, upstream request, archive or error message. Unknown routes are
// explicitly unjudgeable, not approximately redacted.
export const MULTISTEP_ROUTES = {
  "/api/login": "POST",
  "/api/session": "GET",
  "/api/slots": "GET",
  "/api/book": "POST",
} as const;

export type MultiStepRoute = keyof typeof MULTISTEP_ROUTES;
export const UNKNOWN_ROUTE = "<unknown-route>";

export function knownRoute(path: string | null | undefined): MultiStepRoute | null {
  if (typeof path !== "string") return null;
  return Object.hasOwn(MULTISTEP_ROUTES, path) ? path as MultiStepRoute : null;
}

export function routeFromUrl(url: string | null | undefined): MultiStepRoute | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      ? knownRoute(parsed.pathname) : null;
  } catch {
    return null;
  }
}

export const MULTISTEP_STEP_TITLES = ["login", "session", "slots", "book 09:30", "confirm transaction"] as const;
export type MultiStepStepTitle = typeof MULTISTEP_STEP_TITLES[number];
export function knownStepTitle(title: string | null | undefined): MultiStepStepTitle | null {
  return typeof title === "string" && (MULTISTEP_STEP_TITLES as readonly string[]).includes(title)
    ? title as MultiStepStepTitle : null;
}
