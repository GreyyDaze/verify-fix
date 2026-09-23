// Environment for a sandboxed run — Checkly's own convention, nothing invented:
//   ENVIRONMENT_URL   the target (a deployment hook sets it; `checkly test -e`
//                     or `--env-file` set it locally)
//   ENVIRONMENT_NAME  the environment's label (preview / production / …)
// plus the check's own variables (`environmentVariables` on the check, given
// here through --env-file, never stored in the bundle).
//
// A check that reads a variable nobody provides cannot run faithfully. Two
// forms are recognized: `{{VAR}}` handlebars (API checks, config) and
// `process.env.VAR` (Playwright / code). A `process.env.VAR` followed by a
// fallback (`?? x`, `|| x`) still runs, so it is only noted.

export const CHECKLY_ENV = ["ENVIRONMENT_URL", "ENVIRONMENT_NAME"] as const;

/** dotenv-style `KEY=VALUE` lines (comments and blanks ignored, quotes stripped). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export interface EnvReference {
  name: string;
  form: "handlebars" | "process.env";
  /** process.env.X ?? "default" — runs without the variable */
  hasFallback: boolean;
  line: number;
}

export function referencedEnvVars(source: string): EnvReference[] {
  const out: EnvReference[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g)) {
      const key = `hb:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: m[1], form: "handlebars", hasFallback: false, line: i + 1 });
    }
    for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)(\s*(\?\?|\|\|))?/g)) {
      const key = `pe:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: m[1], form: "process.env", hasFallback: Boolean(m[2]), line: i + 1 });
    }
  });
  return out;
}

export interface EnvCheck {
  /** variables the check needs that nobody provides → the scene cannot run faithfully */
  missing: EnvReference[];
  /** variables read with a fallback and not provided → runs on the default; noted */
  defaulted: EnvReference[];
  /** variables the patch reads that the bundle's check config never declared */
  undeclared: string[];
}

export function checkEnv(source: string, provided: Record<string, string>, declared: string[]): EnvCheck {
  const refs = referencedEnvVars(source);
  const has = (n: string) => provided[n] !== undefined && provided[n] !== "";
  const missing = refs.filter((r) => !has(r.name) && !r.hasFallback);
  const defaulted = refs.filter((r) => !has(r.name) && r.hasFallback);
  const known = new Set<string>([...CHECKLY_ENV, ...declared]);
  const undeclared = [...new Set(refs.map((r) => r.name))].filter((n) => !known.has(n));
  return { missing, defaulted, undeclared };
}
