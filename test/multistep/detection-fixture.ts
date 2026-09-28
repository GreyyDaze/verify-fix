// Synthetic-only Stage 7 local execution fixtures. Neither a captured private
// Checkly run nor a browser/deployment/cloud attestation.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DETECTION_WEB = new URL("../../examples/slots-booking/web/", import.meta.url).pathname;
export const DETECTION_FILE = "checks/multistep-booking.spec.ts";
export const DETECTION_SPEC = readFileSync(join(DETECTION_WEB, DETECTION_FILE), "utf8");

/** A real static repair of the nested booking contract, not an edited oracle
 * or a response-rewriting check. Keep the original five ordered steps and
 * exact status, account, slot, version and confirmation assertions. */
export function repairedNestedSpec(): string {
  const start = DETECTION_SPEC.indexOf("await test.step('book 09:30'");
  const end = DETECTION_SPEC.indexOf("await test.step('confirm transaction'", start);
  if (start < 0 || end < 0) throw new Error("synthetic fixture: canonical book step missing");
  let book = DETECTION_SPEC.slice(start, end).replace("booking?: unknown",
    "booking: { confirmed?: unknown; status?: unknown; account?: unknown; slot?: unknown; sessionVersion?: unknown }");
  for (const [before, after] of [
    ["body.confirmed", "body.booking.confirmed"],
    ["body.booking).toBe('CONFIRMED')", "body.booking.status).toBe('CONFIRMED')"],
    ["body.account", "body.booking.account"],
    ["body.slot", "body.booking.slot"],
    ["body.version", "body.booking.sessionVersion"],
    ["bookingResult = body.booking as string", "bookingResult = body.booking.status as string"],
  ]) book = book.replaceAll(before, after);
  return DETECTION_SPEC.slice(0, start) + book + DETECTION_SPEC.slice(end);
}

export interface DetectionApp {
  origin: string;
  paths: string[];
  accounts: string[];
  close(): Promise<void>;
}

export function startDetectionApp(options: {
  bookStatus?: number;
  /** A flat or incomplete body may not be converted to a nested fact. */
  flat?: boolean;
  bookConfirmed?: boolean;
  extraBookField?: string;
  versionMismatch?: boolean;
  accountMismatch?: boolean;
  bookHeaders?: Record<string, string>;
} = {}): Promise<DetectionApp> {
  const paths: string[] = [];
  const accounts: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (part: Buffer) => chunks.push(part));
    req.on("end", () => {
      let data: Record<string, unknown> = {};
      try { data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {}; }
      catch { /* malformed requests cannot impersonate the account */ }
      const route = req.url ?? "";
      paths.push(`${req.method} ${route}`);
      const bearer = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer token-")
        ? req.headers.authorization.slice("Bearer token-".length) : null;
      let status = 200;
      let body: Record<string, unknown>;
      if (req.method === "POST" && route === "/api/login" && typeof data.account === "string") {
        accounts.push(data.account);
        body = { ok: true, account: data.account, version: 1, token: `token-${data.account}` };
      } else if (req.method === "GET" && route === "/api/session" && bearer) {
        body = { valid: true, account: bearer, tokenVersion: 1, currentVersion: 1 };
      } else if (req.method === "GET" && route === "/api/slots") {
        body = { slots: ["09:30", "10:00"], delayMs: 0 };
      } else if (req.method === "POST" && route === "/api/book" && bearer) {
        status = options.bookStatus ?? 200;
        const account = options.accountMismatch ? "wrong-fixture-account" : bearer;
        body = options.flat
          ? { confirmed: true, booking: "CONFIRMED", account, slot: data.slot, version: 1 }
          : { booking: { confirmed: options.bookConfirmed ?? true, status: "CONFIRMED", account,
            slot: data.slot, sessionVersion: options.versionMismatch ? 2 : 1 } };
        if (options.extraBookField) body.extra = options.extraBookField;
      } else {
        status = 401;
        body = { error: "invalid synthetic transaction" };
      }
      res.writeHead(status, { "content-type": "application/json",
        ...(req.method === "POST" && route === "/api/book" ? options.bookHeaders : {}) });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("synthetic detection app: no address");
    resolve({ origin: `http://127.0.0.1:${addr.port}`, paths, accounts,
      close: () => new Promise<void>((done) => server.close(() => done())) });
  }));
}
