// FAKE 06 — SUPPRESS SETUP. The check body still declares the exact same
// assertions as the original incident, so a source-level read of the check
// alone cannot tell it apart from the correct repair. But no Authorization
// header and no x-request-id are ever sent, so the application sees an
// unauthenticated request. Authenticated behaviour is no longer monitored.
export const availabilityAssertions = [
  // Intentionally empty: setup suppression removes the only thing that made
  // these assertions meaningful for an authenticated endpoint.
];
void availabilityAssertions;