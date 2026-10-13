// Structured transaction extraction from a normalized Multistep capture.
//
// Produces the ordered transaction (one entry per canonical step, in capture
// order) and the sensitive relationships the real assets proved: exactly one
// account value reused through the transaction, exactly one login-issued
// token whose value appears three times (login response body + both
// Authorization headers), the selected slot, and the session version. When
// the token relationship is missing or inconsistent the extraction fails
// with a reason — the decision layer maps that to UNCERTAIN.

import type { MultiStepCapture, MultiStepRequestEvidence, MultiStepStepEvidence } from "./normalize.ts";
import { rawTokenOccurrences } from "./raw-evidence.ts";

export interface TransactionRequest {
  method: string;
  path: string;
  status: number | null;
}

export interface TransactionStep {
  title: string;
  status: MultiStepStepEvidence["status"];
  error: string | null;
  requests: TransactionRequest[];
  assertionCount: number;
}

export interface RelationshipSite {
  site: string;
}

export interface MultiStepTransaction {
  steps: TransactionStep[];
  /** the one account value reused through the transaction */
  account: { value: string; sites: string[] } | null;
  /** the one login-issued token; occurrences list every place it appears */
  token: { value: string; sites: string[]; occurrences: number } | null;
  slot: { value: string; sites: string[] } | null;
  version: { value: number; sites: string[] } | null;
  /** missing/inconsistent relationships → UNCERTAIN */
  problems: string[];
}

function bearerOf(headers: Record<string, string>): string | null {
  const value = headers.authorization ?? headers.Authorization ?? null;
  if (!value) return null;
  const m = /^Bearer\s+(\S+)$/.exec(value.trim());
  return m ? m[1] : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Every string in a JSON value (depth-first, leaves only). */
function stringsOf(value: unknown, problems: string[]): string[] {
  const out: string[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 30_000 || current.depth > 32) {
      problems.push("MULTISTEP_RAW_SCHEMA_INVALID");
      return [];
    }
    if (typeof current.value === "string") out.push(current.value);
    else if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else if (isPlainObject(current.value)) {
      for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return out;
}

function findStep(capture: MultiStepCapture, title: string): MultiStepStepEvidence | undefined {
  return capture.steps.find((s) => s.title === title);
}

function firstJson(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export function extractTransaction(capture: MultiStepCapture): MultiStepTransaction {
  const problems: string[] = [];
  const steps: TransactionStep[] = capture.steps.map((step) => ({
    title: step.title,
    status: step.status,
    error: step.error,
    requests: step.requests.map((r) => ({ method: r.method ?? "?", path: r.path ?? r.url ?? "?", status: r.status })),
    assertionCount: step.assertions.length,
  }));

  // ---- account: ONE unique value reused through the transaction ----
  const login = findStep(capture, "login");
  const loginBody = login?.requests[0]?.responseBody ?? null;
  const accountFromLogin = stringsOf(loginBody, problems).length ? (isPlainObject(loginBody) ? (typeof loginBody.account === "string" ? loginBody.account : null) : null) : null;
  const accountSites: string[] = [];
  let account: MultiStepTransaction["account"] = null;
  // Every value stored under an `account` key anywhere in the capture must
  // be the SAME value — a second distinct value is a broken identity.
  const accountValues = new Set<string>();
  const collectAccountValues = (value: unknown): void => {
    const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const current = pending.pop()!;
      if (++nodes > 30_000 || current.depth > 32) {
        problems.push("MULTISTEP_RAW_SCHEMA_INVALID");
        return;
      }
      if (Array.isArray(current.value)) {
        for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      } else if (isPlainObject(current.value)) {
        for (const [key, item] of Object.entries(current.value)) {
          if (key === "account" && typeof item === "string" && item !== "") accountValues.add(item);
          else pending.push({ value: item, depth: current.depth + 1 });
        }
      }
    }
  };
  for (const step of capture.steps) {
    for (const request of step.requests) {
      collectAccountValues(request.requestBody);
      collectAccountValues(request.responseBody);
    }
    for (const assertion of step.assertions) {
      collectAccountValues(assertion.expected);
      collectAccountValues(assertion.actual);
    }
  }
  if (accountValues.size > 1) {
    problems.push(`account relationship inconsistent: ${accountValues.size} distinct account values appear across the required account sites — exactly one unique account identity is required`);
  }
  if (accountFromLogin) {
    accountSites.push("login.response.body.account");
    for (const step of capture.steps) {
      for (let i = 0; i < step.requests.length; i++) {
        const request = step.requests[i];
        const reqBody = request.requestBody;
        if (typeof reqBody === "string") {
          // serialized JSON body
          try {
            if (stringsOf(JSON.parse(reqBody), problems).includes(accountFromLogin)) accountSites.push(`${step.title}[${i}].request.body.account`);
          } catch {
            /* text body — substring handled by the sanitizer */
          }
        } else if (stringsOf(reqBody, problems).includes(accountFromLogin)) {
          accountSites.push(`${step.title}[${i}].request.body.account`);
        }
        if (stringsOf(request.responseBody, problems).includes(accountFromLogin) && !(step.title === "login" && i === 0)) {
          accountSites.push(`${step.title}[${i}].response.body.account`);
        }
      }
    }
    account = { value: accountFromLogin, sites: [...new Set(accountSites)] };
  } else {
    problems.push("account relationship missing: the login response carries no account value");
  }

  // ---- token: one login-issued value, EXACTLY three occurrences ----
  // Occurrence 1: login response body; occurrences 2-3: the two Bearer
  // Authorization headers. Authorization must be Bearer-only (any other
  // scheme is refused — it must never be serialized), and the token value
  // must not appear in ANY other field of the capture.
  const tokenFromLogin = isPlainObject(loginBody) && typeof loginBody.token === "string" ? (loginBody.token as string) : null;
  const tokenSites: string[] = [];
  let token: MultiStepTransaction["token"] = null;
  let bearerCount = 0;
  let inconsistent = false;
  for (const step of capture.steps) {
    for (const request of step.requests) {
      const rawAuth = request.requestHeaders.authorization ?? request.requestHeaders.Authorization ?? null;
      if (rawAuth !== null && !/^Bearer\s+\S+$/.test(rawAuth.trim())) {
        problems.push(`token relationship inconsistent: a non-Bearer Authorization scheme appears in step "${step.title}" — only \`Bearer <token>\` is serializable and this capture must never be stored`);
        continue;
      }
      const bearer = bearerOf(request.requestHeaders);
      if (bearer === null) continue;
      bearerCount += 1;
      if (tokenFromLogin !== null && bearer !== tokenFromLogin) inconsistent = true;
      tokenSites.push(`${step.title}.request.headers.authorization`);
    }
  }
  // Occurrence scan: the token value must appear in exactly three places.
  if (tokenFromLogin !== null && tokenFromLogin !== "") {
    let extraOccurrences = 0;
    const walk = (value: unknown, path: string, visit: (path: string, text: string) => void, depth: number): void => {
      if (depth > 12) return;
      if (typeof value === "string") visit(path, value);
      else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`, visit, depth + 1);
      else if (isPlainObject(value)) for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, visit, depth + 1);
    };
    const allowed = (path: string, text: string): boolean => {
      if (/^login\[\d+\]\.response\.body\.token$/.test(path) && text === tokenFromLogin) return true;
      if (/\.request\.headers\.authorization$/.test(path) && text === `Bearer ${tokenFromLogin}`) return true;
      return false;
    };
    for (const step of capture.steps) {
      for (let i = 0; i < step.requests.length; i++) {
        const request = step.requests[i];
        walk(request.requestBody, `${step.title}[${i}].request.body`, (pth, text) => { if (text.includes(tokenFromLogin) && !allowed(pth, text)) extraOccurrences += 1; }, 0);
        walk(request.responseBody, `${step.title}[${i}].response.body`, (pth, text) => { if (text.includes(tokenFromLogin) && !allowed(pth, text)) extraOccurrences += 1; }, 0);
        for (const [name, value] of Object.entries(request.requestHeaders)) {
          walk(value, `${step.title}[${i}].request.headers.${name}`, (pth, text) => { if (text.includes(tokenFromLogin) && !allowed(pth, text)) extraOccurrences += 1; }, 0);
        }
        walk(request.expected, `${step.title}[${i}].expected`, (pth, text) => { if (text.includes(tokenFromLogin) && !allowed(pth, text)) extraOccurrences += 1; }, 0);
        walk(request.actual, `${step.title}[${i}].actual`, (pth, text) => { if (text.includes(tokenFromLogin) && !allowed(pth, text)) extraOccurrences += 1; }, 0);
      }
      for (let i = 0; i < step.assertions.length; i++) {
        walk(step.assertions[i].expected, `${step.title}.assertion[${i}].expected`, (pth, text) => { if (text.includes(tokenFromLogin) && !allowed(pth, text)) extraOccurrences += 1; }, 0);
        walk(step.assertions[i].actual, `${step.title}.assertion[${i}].actual`, (pth, text) => { if (text.includes(tokenFromLogin) && !allowed(pth, text)) extraOccurrences += 1; }, 0);
      }
      if (step.error !== null && step.error.includes(tokenFromLogin)) extraOccurrences += 1;
    }
    if (capture.logs) {
      for (const entry of capture.logs) if (entry.msg.includes(tokenFromLogin)) extraOccurrences += 1;
    }
    if (capture.checkRunData) {
      for (const field of [capture.checkRunData.script, capture.checkRunData.scriptPath]) {
        if (field !== null && field.includes(tokenFromLogin)) extraOccurrences += 1;
      }
    }
    if (extraOccurrences > 0) {
      problems.push(`token relationship inconsistent: the login token appears in ${extraOccurrences} unsupported location(s) — exactly three occurrences are required (login response body + two Bearer Authorization headers)`);
    }
  }
  if (tokenFromLogin !== null) {
    const rawOccurrences = rawTokenOccurrences(capture, tokenFromLogin);
    if (rawOccurrences !== null && rawOccurrences !== 3) {
      problems.push("MULTISTEP_TOKEN_RELATIONSHIP_INVALID");
    }
    tokenSites.unshift("login.response.body.token");
    if (bearerCount === 0) {
      problems.push("token relationship missing: the login token never appears in an Authorization header");
    } else if (inconsistent) {
      problems.push("token relationship inconsistent: an Authorization header does not use the login-issued token");
    } else if (bearerCount !== 2) {
      problems.push(`token relationship inconsistent: expected exactly 3 token occurrences (login body + two Bearer headers), observed ${1 + bearerCount}`);
    } else {
      token = { value: tokenFromLogin, sites: [...new Set(tokenSites)], occurrences: 1 + bearerCount };
    }
  } else {
    problems.push(bearerCount > 0
      ? "token relationship inconsistent: Authorization headers exist but the login response carries no token"
      : "token relationship missing: neither the login response nor any Authorization header carries a token");
  }

  // ---- slot: request body vs response body of the booking step ----
  const book = findStep(capture, "book 09:30") ?? capture.steps.find((s) => s.requests.some((r) => /\/api\/book$/.test(r.path ?? "")));
  let slot: MultiStepTransaction["slot"] = null;
  if (book) {
    const request = book.requests[0];
    const reqBody = request?.requestBody;
    let slotFromRequest: string | null = null;
    if (isPlainObject(reqBody) && typeof reqBody.slot === "string") slotFromRequest = reqBody.slot;
    else if (typeof reqBody === "string") {
      try {
        const parsed = JSON.parse(reqBody);
        if (isPlainObject(parsed) && typeof parsed.slot === "string") slotFromRequest = parsed.slot;
      } catch { /* non-JSON body */ }
    }
    const responseStrings = stringsOf(request?.responseBody ?? null, problems);
    const slotFromResponse = responseStrings.find((s) => /^\d{2}:\d{2}$/.test(s)) ?? null;
    const sites: string[] = [];
    if (slotFromRequest) sites.push(`${book.title}.request.body.slot`);
    if (slotFromResponse) sites.push(`${book.title}.response.body.slot`);
    if (slotFromRequest && slotFromResponse && slotFromRequest !== slotFromResponse) {
      problems.push("slot relationship inconsistent: request and response values differ");
    } else if (slotFromRequest || slotFromResponse) {
      slot = { value: (slotFromRequest ?? slotFromResponse)!, sites };
    }
  }

  // ---- version: login version vs session/book echoes ----
  let version: MultiStepTransaction["version"] = null;
  if (isPlainObject(loginBody) && typeof loginBody.version === "number") {
    const value = loginBody.version as number;
    const sites = ["login.response.body.version"];
    for (const step of capture.steps) {
      if (step.title === "login") continue;
      for (const request of step.requests) {
        const body = request.responseBody;
        if (!isPlainObject(body)) continue;
        for (const key of ["tokenVersion", "currentVersion", "version", "sessionVersion"] as const) {
          if (body[key] === value) sites.push(`${step.title}.response.body.${key}`);
        }
        if (isPlainObject(body.booking) && body.booking.sessionVersion === value) {
          sites.push(`${step.title}.response.body.booking.sessionVersion`);
        }
      }
    }
    version = { value, sites: [...new Set(sites)] };
  }

  return { steps, account, token, slot, version, problems: [...new Set(problems)] };
}

/** The four canonical requests of the real transaction, from evidence. */
export function requestSequence(capture: MultiStepCapture): Array<{ step: string; request: TransactionRequest }> {
  const out: Array<{ step: string; request: TransactionRequest }> = [];
  for (const step of capture.steps) {
    for (const request of step.requests) {
      out.push({ step: step.title, request: { method: request.method ?? "?", path: request.path ?? request.url ?? "?", status: request.status } });
    }
  }
  return out;
}
