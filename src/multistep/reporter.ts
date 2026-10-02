// The trusted reporter runs in the Playwright runner process. JSON reporter
// serializes test.step but filters pw:api; onStepBegin still receives API
// request method/URL + parent step. Send ONLY fixed route names and booleans
// through a dedicated pipe (fd 3), never stderr, stdout, or a candidate file.
// The bridge independently observes the HTTP traffic. Neither source alone
// can make a bridged run conclusive.
export interface ReporterRequestEvidence {
  method: "GET" | "POST" | "OTHER";
  path: string;
  step: string;
  originMatches: boolean;
  hasQuery: boolean;
}

export const MAX_REPORTER_AUDIT_BYTES = 256 * 1024;

export const TRUSTED_REQUEST_REPORTER = `
'use strict'
const fs = require('node:fs')
const ROUTES = new Set(['/api/login', '/api/session', '/api/slots', '/api/book'])
const STEPS = new Set(['login', 'session', 'slots', 'book 09:30', 'confirm transaction'])
module.exports = class VerifyFixRequestReporter {
  constructor() { this.requests = []; this.overflow = false }
  onStepBegin(_test, _result, step) {
    if (step.category !== 'pw:api' || !step.params || typeof step.params.url !== 'string' || typeof step.params.method !== 'string') return
    if (this.requests.length >= 128) { this.overflow = true; return }
    let route = '<unknown-route>', originMatches = false, hasQuery = true
    try {
      const url = new URL(step.params.url)
      route = ROUTES.has(url.pathname) ? url.pathname : route
      originMatches = url.origin === process.env.ENVIRONMENT_URL
      hasQuery = url.search !== '' || url.hash !== ''
    } catch { /* invalid URL is unjudgeable, not serialized */ }
    let parent = step.parent
    while (parent && parent.category !== 'test.step') parent = parent.parent
    const title = parent && STEPS.has(parent.title) ? parent.title : '<unknown-step>'
    this.requests.push({
      method: step.params.method === 'GET' || step.params.method === 'POST' ? step.params.method : 'OTHER',
      path: route, step: title, originMatches, hasQuery,
    })
  }
  onEnd() {
    fs.writeSync(3, JSON.stringify({ version: 1, requests: this.requests, overflow: this.overflow }))
  }
}
`;

/** The pipe is untrusted input until every field matches the strict schema. */
export function parseReporterAudit(text: string): ReporterRequestEvidence[] | null {
  if (!text || Buffer.byteLength(text, "utf8") > MAX_REPORTER_AUDIT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    if (Object.keys(root).length !== 3 || !["version", "requests", "overflow"].every((key) => Object.hasOwn(root, key))
      || root.version !== 1 || root.overflow !== false || !Array.isArray(root.requests) || root.requests.length > 128) return null;
    const requests: ReporterRequestEvidence[] = [];
    for (const item of root.requests) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const req = item as Record<string, unknown>;
      if (Object.keys(req).length !== 5 || !["method", "path", "step", "originMatches", "hasQuery"].every((key) => Object.hasOwn(req, key))
        || !(["GET", "POST", "OTHER"] as unknown[]).includes(req.method)
        || typeof req.path !== "string" || typeof req.step !== "string"
        || typeof req.originMatches !== "boolean" || typeof req.hasQuery !== "boolean"
        || !(["/api/login", "/api/session", "/api/slots", "/api/book", "<unknown-route>"] as string[]).includes(req.path)
        || !(["login", "session", "slots", "book 09:30", "confirm transaction", "<unknown-step>"] as string[]).includes(req.step)) return null;
      requests.push({ method: req.method as ReporterRequestEvidence["method"], path: req.path, step: req.step, originMatches: req.originMatches, hasQuery: req.hasQuery });
    }
    return requests;
  } catch {
    return null;
  }
}
