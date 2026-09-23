// A candidate fix is a set of files that replace files under the bundle's
// check/ directory: the spec, checkly.config.ts, or both. `--patch` accepts
//   a file       → replaces the bundle's main check file, whatever the file is named
//   a directory  → every file in it replaces the bundle file with the same relative path
// That is what a coding agent's pull request changes; nothing is applied as a
// unified diff, so no external tool is needed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Bundle, BundleConfig } from "./types.ts";
import { parseCheckConfig } from "./scene/config-diff.ts";

export interface PatchSet {
  kind: "file" | "directory" | "inline";
  path: string | null;
  /** relative path under check/ → new content */
  files: Record<string, string>;
}

export function loadPatch(pathIn: string, bundle: Bundle): PatchSet {
  const path = resolve(pathIn);
  if (statSync(path).isDirectory()) {
    const files: Record<string, string> = {};
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else files[relative(path, p).split("\\").join("/")] = readFileSync(p, "utf8");
      }
    };
    walk(path);
    if (Object.keys(files).length === 0) throw new Error(`patch directory ${path} is empty`);
    return { kind: "directory", path, files };
  }
  return { kind: "file", path, files: { [bundle.check.file]: readFileSync(path, "utf8") } };
}

/** A patch given as check source text (tests, embedding). */
export function inlinePatch(bundle: Bundle, checkSource: string): PatchSet {
  return { kind: "inline", path: null, files: { [bundle.check.file]: checkSource } };
}

export function patchedCheckSource(bundle: Bundle, patch: PatchSet): string {
  return patch.files[bundle.check.file] ?? bundle.checkSource;
}

export function patchedConfigSource(bundle: Bundle, patch: PatchSet): string | null {
  const configPath = bundle.configFile ?? "checkly.config.ts";
  return patch.files[configPath] ?? (bundle.configFile ? bundle.files[bundle.configFile] : null);
}

export function originalConfigSource(bundle: Bundle): string | null {
  return bundle.configFile ? bundle.files[bundle.configFile] : null;
}

/** files in the patch that do not exist in the bundle (new helpers etc.) */
export function newFiles(bundle: Bundle, patch: PatchSet): string[] {
  return Object.keys(patch.files).filter((f) => bundle.files[f] === undefined && f !== bundle.check.file);
}

/** The check config after the patch: the bundle's config with every key the patched file states. */
export function patchedConfig(bundle: Bundle, patch: PatchSet): BundleConfig | null {
  const source = patchedConfigSource(bundle, patch);
  const base = bundle.config;
  if (!source) return base;
  const view = parseCheckConfig(source);
  if (!base) {
    if (view.runParallel === null && view.locations === null) return null;
    return { runParallel: view.runParallel ?? false, locations: view.locations ?? [], frequencyMinutes: view.frequency && /^\d+$/.test(view.frequency) ? Number(view.frequency) : null, environmentVariables: view.envKeys };
  }
  return {
    runParallel: view.runParallel ?? base.runParallel,
    locations: view.locations ?? base.locations,
    frequencyMinutes: view.frequency && /^\d+$/.test(view.frequency) ? Number(view.frequency) : base.frequencyMinutes,
    environmentVariables: view.envKeys.length ? [...new Set([...base.environmentVariables, ...view.envKeys])] : base.environmentVariables,
  };
}
