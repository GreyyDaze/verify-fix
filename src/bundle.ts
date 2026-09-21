// Evidence bundle loader (prod PRD §7, bundle schema v2).
// A bundle is a directory: incidents/<id>/manifest.json + check/<file> + optional
// app-sim.ts (the deterministic app-under-test simulator the synthetic executor
// drives — production swaps this for the real app + real Checkly).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Bundle } from "./types.ts";

export interface LoadedBundle {
  bundle: Bundle;
  /** absolute path to the deterministic app simulator module (fixture-provided). */
  appSimPath: string | null;
}

export function loadBundle(dir: string): LoadedBundle {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`bundle manifest not found: ${manifestPath}`);
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if (raw.schemaVersion !== "v2") throw new Error(`unsupported bundle schemaVersion: ${String(raw.schemaVersion)}`);
  const bundle = raw as unknown as Bundle;
  const checkPath = join(dir, "check", bundle.check.file);
  if (!existsSync(checkPath)) {
    throw new Error(`check source for "${bundle.check.file}" not found at ${checkPath}`);
  }
  bundle.checkSource = readFileSync(checkPath, "utf8");
  const appSimPath = join(dir, "app-sim.ts");
  return { bundle, appSimPath: existsSync(appSimPath) ? appSimPath : null };
}