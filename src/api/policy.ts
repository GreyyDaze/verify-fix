import { parseApiCheckProject, type ApiAssertionModel, type ApiCheckModel } from "./model.ts";

export interface ApiPolicyResult {
  rejected: string | null;
  uncertain: string | null;
  notes: string[];
  original: ApiCheckModel | null;
  candidate: ApiCheckModel | null;
}

function normalizeUrl(template: string): { variable: boolean; path: string; query: string } | null {
  const variable = template.startsWith("{{ENVIRONMENT_URL}}");
  const parseable = variable ? `https://verify-fix.invalid${template.slice("{{ENVIRONMENT_URL}}".length)}` : template;
  try {
    const url = new URL(parseable);
    return { variable, path: url.pathname, query: url.search };
  } catch {
    return null;
  }
}

function assertionKey(assertion: ApiAssertionModel): string {
  return `${assertion.property}|${assertion.selector ?? ""}|${assertion.operator}|${JSON.stringify(assertion.target)}`;
}

function responseRewrite(source: string): boolean {
  return /\bresponse\s*(?:\[[^\]]+\]|\.[A-Za-z_$][\w$]*)\s*=|Object\.assign\s*\(\s*response\b|\bresponse\.(?:body|status|statusCode|headers)\s*\.(?:push|set|delete|clear)\s*\(/.test(source);
}

function requestIdentityRewrite(source: string): boolean {
  return /\brequest\s*\.\s*(?:url|method|body|queryParameters)\s*=|\brequest\s*\[\s*['"](?:url|method|body|queryParameters)['"]\s*\]\s*=/.test(source);
}

function moduleClosure(entry: string, files: Map<string, string>): Array<{ file: string; source: string }> {
  const normalized = new Map([...files].map(([file, source]) => [file.replace(/\\/g, "/"), source]));
  const queue = [entry.replace(/\\/g, "/")];
  const seen = new Set<string>();
  const output: Array<{ file: string; source: string }> = [];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = normalized.get(file);
    if (source === undefined) continue;
    output.push({ file, source });
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      const base = new URL(match[1], `file:///${file}`).pathname.replace(/^\//, "");
      const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
      const imported = candidates.find((candidate) => normalized.has(candidate));
      if (imported) queue.push(imported);
    }
  }
  return output;
}

function exact(assertion: ApiAssertionModel): boolean {
  return assertion.operator === "equals";
}

export function evaluateApiPolicy(
  originalCheckFile: string,
  originalFiles: Map<string, string>,
  candidateCheckFile: string,
  candidateFiles: Map<string, string>,
  logicalId?: string | null,
): ApiPolicyResult {
  const original = parseApiCheckProject(originalCheckFile, originalFiles, logicalId);
  const candidate = parseApiCheckProject(candidateCheckFile, candidateFiles, logicalId);
  const notes: string[] = [];
  const fail = (reason: string): ApiPolicyResult => ({ rejected: reason, uncertain: null, notes, original, candidate });
  const unsure = (reason: string): ApiPolicyResult => ({ rejected: null, uncertain: reason, notes, original, candidate });

  if (!original) return unsure("the incident ApiCheck could not be parsed from the bundle");
  if (!candidate) return fail("the candidate removes the incident ApiCheck");
  const candidateCheckText = moduleClosure(candidate.checkFile, candidateFiles).map((module) => module.source).join("\n");
  if (/\bshouldFail\s*:\s*true\b/.test(candidateCheckText)) return fail("ApiCheck shouldFail may not invert the result");
  if (original.errors.length) return unsure(`the incident ApiCheck cannot be safely resolved: ${original.errors.join("; ")}`);
  if (candidate.errors.length) return unsure(`the candidate ApiCheck cannot be safely resolved: ${candidate.errors.join("; ")}`);
  if (candidate.shouldFail) return fail("ApiCheck shouldFail may not invert the result");

  const originalUrl = normalizeUrl(original.request.url);
  const candidateUrl = normalizeUrl(candidate.request.url);
  if (!originalUrl || !candidateUrl) return unsure("the API request URL cannot be parsed safely");
  if (!candidateUrl.variable) return fail("the API request must keep {{ENVIRONMENT_URL}}; hardcoded hosts are forbidden");
  if (candidateUrl.path !== originalUrl.path || candidateUrl.query !== originalUrl.query) {
    return fail(`the API route or query changed (${originalUrl.path}${originalUrl.query} → ${candidateUrl.path}${candidateUrl.query})`);
  }
  if (candidate.request.method !== original.request.method) return fail(`the API method changed (${original.request.method} → ${candidate.request.method})`);
  if (candidate.request.body !== original.request.body) return fail("the API request body changed");
  for (const key of original.environmentKeys) {
    if (!candidate.environmentKeys.includes(key)) return fail(`required Checkly environment variable ${key} was removed`);
  }

  if (!candidate.setupFile) return fail("the authenticated API setup script was removed");
  const setupSource = candidateFiles.get(candidate.setupFile);
  if (setupSource === undefined) return unsure(`the candidate setup script ${candidate.setupFile} is missing from the complete source tree`);
  const setupClosure = moduleClosure(candidate.setupFile, candidateFiles);
  const setupText = setupClosure.map((module) => module.source).join("\n");
  if (!/process\.env(?:\.API_TOKEN|\[\s*['"]API_TOKEN['"]\s*\])/.test(setupText)) return fail("the setup closure must read API_TOKEN from process.env");
  if (!/["']?authorization["']?/i.test(setupText)) return fail("the setup closure must add the Authorization header");
  if (!/x-request-id/i.test(setupText)) return fail("the setup closure must add request identity");
  for (const module of setupClosure) {
    if (responseRewrite(module.source)) return fail(`the setup closure rewrites the response in ${module.file}`);
    if (requestIdentityRewrite(module.source)) return fail(`the setup closure rewrites the request route, query, method, or body in ${module.file}`);
  }
  if (candidate.teardownFile) {
    const teardown = candidateFiles.get(candidate.teardownFile);
    if (teardown === undefined) return unsure(`the candidate teardown script ${candidate.teardownFile} is missing from the complete source tree`);
    for (const module of moduleClosure(candidate.teardownFile, candidateFiles)) {
      if (responseRewrite(module.source)) return fail(`the teardown closure rewrites the response before assertions run in ${module.file}`);
    }
  }

  if (candidate.retrySource !== original.retrySource) return fail("retry changes cannot repair an unchanged API contract");
  if (candidate.timeoutSource !== original.timeoutSource) return fail("timeout-only changes cannot repair an unchanged API contract");

  const candidateExact = candidate.request.assertions.filter(exact);
  if (candidateExact.length !== candidate.request.assertions.length) return fail("API contract assertions must remain exact; weaker operators are forbidden");
  if (candidate.request.assertions.length < original.request.assertions.length) return fail("one or more API contract assertions were removed");

  for (const required of original.request.assertions) {
    if (required.property === "jsonBody" && required.selector === "availability") continue;
    if (!candidate.request.assertions.some((assertion) => assertionKey(assertion) === assertionKey(required))) {
      return fail(`required assertion ${required.assertion.subject}.${required.operator}(${JSON.stringify(required.target)}) was removed or changed`);
    }
  }

  const originalField = original.request.assertions.find((assertion) => assertion.property === "jsonBody" && assertion.selector === "availability");
  if (originalField) {
    const replacement = candidate.request.assertions.filter((assertion) =>
      assertion.property === "jsonBody" && assertion.operator === originalField.operator && assertion.target === originalField.target,
    );
    if (replacement.length !== 1) return fail("the exact availability contract must have one exact field assertion");
    if (replacement[0].selector !== originalField.selector) notes.push(`API contract field changed from ${originalField.selector} to ${replacement[0].selector}`);
  }

  notes.push("API request method, route, query, body, setup boundary, and exact assertions are preserved");
  return { rejected: null, uncertain: null, notes, original, candidate };
}
