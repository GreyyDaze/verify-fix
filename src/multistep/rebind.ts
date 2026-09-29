// Remote v3 authority lives on disk, not on a mutable caller-owned Bundle.
// Compare the entire derived bundle (including the measured decision-law
// prerequisites), not only a scene pointer or a failing recording. The loader
// independently reopens the bounded manifest, check tree, both result JSONs,
// remote asset hashes and stored recordings. This helper never exposes paths,
// errors, raw assets, account identities or headers to a report.
import type { Bundle } from "../types.ts";
import { loadBundle } from "../bundle.ts";

/** Compare DATA, not JSON.stringify output: a caller-owned toJSON() method
 * (including a non-enumerable or nested one), accessor or sparse array must
 * not impersonate the independently reloaded disk value. Bounded and
 * iterative; no caller method is invoked to produce evidence. */
export function sameBoundedData(candidate: unknown, disk: unknown): boolean {
  const pairs: Array<[unknown, unknown, number]> = [[candidate, disk, 0]];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let chars = 0;
  try {
    while (pairs.length) {
      const [a, b, depth] = pairs.pop()!;
      if (++nodes > 60_000 || depth > 64 || typeof a !== typeof b) return false;
      if (a === null || b === null) {
        if (a !== b) return false;
        continue;
      }
      if (typeof a !== "object") {
        if (typeof a === "number" && (!Number.isFinite(a) || !Number.isFinite(b as number))) return false;
        if (typeof a === "string" && (chars += a.length) > 64 * 1024 * 1024) return false;
        if ((typeof a !== "string" && typeof a !== "number" && typeof a !== "boolean" && a !== undefined)
          || a !== b) return false;
        continue;
      }
      if (seen.has(a)) return false; // a cycle or shared caller object is not JSON data
      seen.add(a);
      if (Array.isArray(a) !== Array.isArray(b)
        || Object.getPrototypeOf(a) !== (Array.isArray(a) ? Array.prototype : Object.prototype)
        || Object.getPrototypeOf(b) !== (Array.isArray(b) ? Array.prototype : Object.prototype)
        || Object.getOwnPropertySymbols(a).length || Object.getOwnPropertySymbols(b).length) return false;
      const keysA = Object.getOwnPropertyNames(a);
      const keysB = Object.getOwnPropertyNames(b);
      if (keysA.length !== keysB.length || keysA.length > 60_000) return false;
      if (Array.isArray(a) && (a.length !== (b as unknown[]).length
        || keysA.length !== a.length + 1 || keysB.length !== (b as unknown[]).length + 1)) return false;
      keysA.sort();
      keysB.sort();
      for (let i = 0; i < keysA.length; i++) {
        const key = keysA[i]!;
        if (key !== keysB[i]) return false;
        const left = Object.getOwnPropertyDescriptor(a, key)!;
        const right = Object.getOwnPropertyDescriptor(b, key)!;
        if (key === "length" && Array.isArray(a)) continue;
        if (key === "toJSON" || !left.enumerable || !right.enumerable
          || !("value" in left) || !("value" in right)
          || (chars += key.length) > 64 * 1024 * 1024) return false;
        pairs.push([left.value, right.value, depth + 1]);
      }
    }
    return true;
  } catch { return false; }
}

export function multiStepDiskRebound(bundle: Bundle): boolean {
  if (bundle.schemaVersion !== "v3" || bundle.check.checkType !== "MULTI_STEP") return false;
  try {
    const loaded = loadBundle(bundle.dir).bundle;
    return loaded.schemaVersion === "v3" && loaded.check.checkType === "MULTI_STEP"
      && loaded.multistep !== null && loaded.multistep !== undefined
      && loaded.multistep.problems.length === 0
      && sameBoundedData(bundle, loaded);
  } catch {
    return false;
  }
}
