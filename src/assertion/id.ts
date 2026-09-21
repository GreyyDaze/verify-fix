// Stable assertion identity shared by the inventory parser AND the sandbox DSL.
// Must stay byte-for-byte identical in both places: it is what lets a runtime
// trace step bind to the inventory assertion it corresponds to (checked-coverage).

export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Normalize a subject so alternate spellings of the same value bind to the same assertion. */
export function normalizeSubject(subject: string): string {
  return subject.replace(/\s+/g, " ").trim();
}

/**
 * Stable assertion identity, shared BY BOTH the inventory scanner (which sees
 * source text) and the runtime DSL (which only sees runtime values). The two
 * can never observe the same subject expression (source text vs value), so the
 * key deliberately drops the subject and binds on (matcher, target) alone.
 *
 * This is what makes the trace→inventory→scene provenance link deterministic:
 * a runtime failure `expect(x).toBe(200)` maps to the same id that inventory
 * assigns `expect(anySubject).toBe(200)` and that the incident scene names as
 * its oracle. Collisions between subjects using the same matcher+target are
 * acceptable — adequacy reasons over assertion *classes*, and the clickthrough
 * step the oracle lives on is recovered from the scene/step evidence, not from
 * the id.
 */
export function assertionKey(_subject: string, matcher: string, target: string): string {
  const m = matcher.replace(/\s+/g, " ").trim();
  const t = normalizeSubject(target);
  return `${m}|${t}`;
}

export function assertionId(subject: string, matcher: string, target: string): string {
  return `assert:${fnv1a(assertionKey(subject, matcher, target)).slice(0, 12)}`;
}