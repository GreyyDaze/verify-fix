// Scene modes — how a scene puts the target into its state. One small grammar,
// written by `verify-fix bundle` into the manifest and read by the executor:
//
//   live                   pass every request through to the target
//   live-concurrent:N      N sandboxed runs at once, interleaved request by
//                          request at the proxy (the overlap the incident had)
//   replay:<file>.har      answer from the recording, no target needed
//   inject:<M> <path> -> <status>
//                          pass through, but answer one request with a failure
//                          (the detection scene: the check must still catch it)
//
// Deterministic string parsing only; unknown modes are an error at load time,
// never a silent "live".

export type ParsedMode =
  | { kind: "live"; concurrency: 1 }
  | { kind: "live-concurrent"; concurrency: number }
  | { kind: "replay"; har: string }
  | { kind: "inject"; rule: InjectRule }
  /** the bundle could not derive the mode (e.g. drift: no failing request to inject) — runs as uncertain */
  | { kind: "pending"; raw: string; reason: string }
  | { kind: "unknown"; raw: string; reason: string };

export interface InjectRule {
  method: string;
  /** pathname to match exactly (query string ignored) */
  path: string;
  status: number;
  raw: string;
}

export function parseMode(mode: string | undefined | null): ParsedMode {
  const raw = (mode ?? "").trim();
  if (raw === "live") return { kind: "live", concurrency: 1 };
  const conc = /^live-concurrent:(\d+)$/.exec(raw);
  if (conc) {
    const n = Number(conc[1]);
    if (n >= 2 && n <= 8) return { kind: "live-concurrent", concurrency: n };
    return { kind: "unknown", raw, reason: `concurrency must be 2..8, got ${conc[1]}` };
  }
  const replay = /^replay:(.+(?:\.har|\.api\.json))$/.exec(raw);
  if (replay) return { kind: "replay", har: replay[1] };
  if (raw.startsWith("inject:<")) {
    // `inject:<failing request unknown>` — written by the bundle command when the
    // failing run had no failing request (drift). Nothing to inject yet.
    return { kind: "pending", raw, reason: `the bundle has no failing request to inject (${raw.slice(7)}); the detection scene cannot run until one is derived` };
  }
  if (raw.startsWith("inject:")) {
    const rule = parseInjectRule(raw.slice("inject:".length));
    if (rule) return { kind: "inject", rule };
    return { kind: "unknown", raw, reason: `inject rule must be "<METHOD> <path> -> <status>", got "${raw.slice(7)}"` };
  }
  return { kind: "unknown", raw, reason: raw ? `unknown scene mode "${raw}"` : "scene has no mode" };
}

export function parseInjectRule(text: string): InjectRule | null {
  const m = /^\s*([A-Z]+)\s+(\/\S*)\s*->\s*(\d{3})\s*$/.exec(text);
  if (!m) return null;
  return { method: m[1], path: m[2].split("?")[0], status: Number(m[3]), raw: text.trim() };
}

/** Does this mode need a live target (`--target`)? */
export function needsTarget(mode: ParsedMode): boolean {
  return mode.kind === "live" || mode.kind === "live-concurrent" || mode.kind === "inject";
}

/**
 * How many runs of the check can overlap under a Checkly config. Checkly runs
 * a check in every location at once when `runParallel` is true; otherwise it
 * round-robins the locations, one run per tick. A concurrency scene is run at
 * min(scene N, effective concurrency), so a scheduling fix is exercised with
 * the overlap it still allows — and a patch that only claims to fix scheduling
 * while keeping runParallel on gets the full overlap.
 */
export function effectiveConcurrency(config: { runParallel: boolean; locations: string[] } | null | undefined): number {
  if (!config) return Number.POSITIVE_INFINITY;
  const n = Math.max(1, config.locations.length);
  return config.runParallel ? n : 1;
}
