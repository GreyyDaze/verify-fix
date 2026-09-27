// Trusted HTTPS origin bridge for Multistep sandbox runs.
//
// Problem: the canonical Multistep check REQUIRES ENVIRONMENT_URL to be a
// bare https origin, while the scene executor's traffic-shaping proxy always
// listens on plain http (http://127.0.0.1:<port>). Handing the check that
// http URL makes setup fail before any request — zero evidence.
//
// This module replaces ONLY the request origin. It terminates TLS on
// 127.0.0.1 with a per-run, runtime-generated self-signed CA (openssl, never
// committed to the repository), and forwards every request to the upstream
// origin transparently:
//
//   - same method, same path and query string, same body bytes,
//   - same request headers (Authorization and Content-Type included; only
//     the Host header changes, because the origin itself is what changed),
//   - same response status, headers, and body passed back untouched —
//     there is no response rewriting here or in candidate code.
//
// TLS scoping: the CA certificate is written to a per-run temporary
// directory and handed to the sandboxed runner ONLY through
// NODE_EXTRA_CA_CERTS in that single child process's environment. Validation
// is never disabled anywhere: the bridge serves a leaf signed by this CA, so
// the runner still performs full certificate validation against a narrowly
// scoped trust anchor. The private key material (CA key, leaf key, CSR) and
// the OpenSSL configuration are deleted from disk immediately after the
// server has loaded them — before candidate execution begins — so during the
// run only the in-memory key and the public CA certificate remain. The
// bridge's own outbound connection to the upstream origin uses the normal
// platform trust store (no rejectUnauthorized=false, ever).
//
// If the boundary cannot be established — openssl missing or failing, TLS
// server cannot listen, upstream URL not http(s) — startOriginBridge throws
// and the executor turns that into UNCERTAIN. It never falls back to an
// http origin or a permissive TLS mode.
//
// Bounded, single-answer forwarding: request and response bodies stream with
// explicit backpressure under fixed size limits, each request gets a fixed
// overall timeout, and every request is answered exactly once — the first
// completion wins; later callbacks are ignored or discarded. Hop-by-hop
// headers (including every header named in Connection) are removed in both
// directions.
//
// Structured evidence: every proxied request is recorded as structured data
// (order, method, sanitized path, query parameter NAMES, request header
// NAMES, status, and Authorization PRESENCE only). Header values, bodies,
// tokens, raw query values, and sensitive path values are never written to
// evidence. Runner stderr is never used as evidence.

import { execFile } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Maximum forwarded request body bytes (larger bodies are refused with 413). */
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
/** Maximum forwarded response body bytes (excess aborts the forward). */
export const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;
/** Maximum combined request header bytes accepted at the bridge. */
export const MAX_HEADER_BYTES = 64 * 1024;
/** Overall per-request timeout: first completion (response or failure) wins. */
export const BRIDGE_REQUEST_TIMEOUT_MS = 30_000;

export interface BridgeRequestEvidence {
  /** 1-based order observed at the bridge within one sandbox run */
  index: number;
  method: string;
  /** sanitized path only (no query; opaque long segments redacted) */
  path: string;
  /** query parameter NAMES only — never values (signed URLs included) */
  queryKeys: string[];
  /** request header names seen at the bridge (names only — never values) */
  requestHeaderNames: string[];
  status: number;
  /** true when an Authorization header was present (value never recorded) */
  authorization: boolean;
  /** true when the bridge could not reach the upstream target */
  forwardError?: boolean;
  /** true when the client hung up before a response was produced */
  clientAborted?: boolean;
}

export interface OriginBridge {
  /** bare https origin to hand the check as ENVIRONMENT_URL */
  origin: string;
  /** absolute path of the per-run CA certificate (NODE_EXTRA_CA_CERTS) */
  caPath: string;
  /**
   * per-run material directory: the CA PUBLIC certificate remains here for
   * NODE_EXTRA_CA_CERTS; the private keys, CSR, and OpenSSL config are
   * deleted before execution begins and the directory is removed on close.
   */
  materialDir: string;
  /** structured evidence collected so far (live array) */
  evidence: BridgeRequestEvidence[];
  close(): Promise<void>;
}

// Portable openssl extension config (works with OpenSSL and LibreSSL):
// a per-run CA and a leaf for 127.0.0.1 signed by that CA.
const OPENSSL_CONFIG = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = 127.0.0.1
OU = verify-fix-multistep-bridge
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[v3_leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,DNS:localhost
subjectKeyIdentifier = hash
`;

const HOP_BY_HOP = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "te",
  "trailers",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

/** Strip hop-by-hop headers, including every header named in Connection. */
function stripHopByHop(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const named: string[] = [];
  const rawConnection = headers["connection"] ?? headers["Connection"];
  if (rawConnection !== undefined) {
    for (const token of String(Array.isArray(rawConnection) ? rawConnection.join(",") : rawConnection).split(",")) {
      const t = token.trim().toLowerCase();
      if (t && t !== "close" && t !== "keep-alive") named.push(t);
    }
  }
  const drop = new Set([...HOP_BY_HOP, ...named]);
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!drop.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * Evidence-safe path: never store sensitive path values. Long opaque
 * segments (token- or key-shaped) are redacted; length is bounded.
 */
function sanitizeEvidencePath(path: string): string {
  const capped = path.length > 512 ? path.slice(0, 512) : path;
  return capped
    .split("/")
    .map((segment) => (/^[A-Za-z0-9+/=_-]{32,}$/.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment) ? "<redacted>" : segment))
    .join("/");
}

function queryKeysOf(query: string): string[] {
  if (!query) return [];
  const keys: string[] = [];
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const rawKey = pair.split("=")[0] ?? "";
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      /* keep the raw key name when it is not percent-encoded */
    }
    if (key) keys.push(key);
  }
  return [...new Set(keys)];
}

async function runOpenssl(args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync("openssl", args, { cwd, timeout: 20_000, windowsHide: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`openssl failed to mint the per-run bridge certificate (${detail.split("\n")[0]})`);
  }
}

/**
 * Start the trusted HTTPS→upstream origin bridge for one sandbox run.
 * Throws when the boundary cannot be established safely — the caller must
 * surface that as UNCERTAIN, never as PASS/FAILED and never by relaxing TLS.
 */
export async function startOriginBridge(upstreamUrl: string): Promise<OriginBridge> {
  let upstream: URL;
  try {
    upstream = new URL(upstreamUrl);
  } catch {
    throw new Error(`upstream target is not a valid URL: ${JSON.stringify(String(upstreamUrl).slice(0, 120))}`);
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`upstream target must be http or https, got ${upstream.protocol}`);
  }

  const dir = await mkdtemp(join(tmpdir(), "verify-fix-bridge-"));
  const cfg = join(dir, "openssl.cnf");
  const caKey = join(dir, "ca-key.pem");
  const caCert = join(dir, "ca.pem");
  const leafKey = join(dir, "leaf-key.pem");
  const leafCsr = join(dir, "leaf.csr");
  const leafCert = join(dir, "leaf.pem");

  try {
    await writeFile(cfg, OPENSSL_CONFIG, "utf8");
    await runOpenssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=verify-fix-multistep-bridge-ca", "-keyout", caKey, "-out", caCert, "-config", cfg, "-extensions", "v3_ca"], dir);
    await runOpenssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", leafKey, "-out", leafCsr, "-config", cfg], dir);
    await runOpenssl(["x509", "-req", "-in", leafCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-days", "2", "-out", leafCert, "-extfile", cfg, "-extensions", "v3_leaf"], dir);
    const [key, cert] = await Promise.all([readFile(leafKey), readFile(leafCert)]);

    const evidence: BridgeRequestEvidence[] = [];
    let closed = false;

    const handle = (req: IncomingMessage, res: ServerResponse): void => {
      const rawUrl = req.url ?? "/";
      const qIndex = rawUrl.indexOf("?");
      const path = sanitizeEvidencePath(qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex));
      const query = qIndex === -1 ? "" : rawUrl.slice(qIndex + 1);
      const method = req.method ?? "GET";
      const authorization = Object.keys(req.headers).some((h) => h.toLowerCase() === "authorization");
      const requestHeaderNames = Object.keys(req.headers).map((h) => h.toLowerCase()).sort();
      const headerBytes = requestHeaderNames.reduce((sum, name) => sum + name.length + (Array.isArray(req.headers[name]) ? (req.headers[name] as string[]).join(",").length : String(req.headers[name] ?? "").length), 0);
      const entry: BridgeRequestEvidence = { index: 0, method, path, queryKeys: queryKeysOf(query), requestHeaderNames, status: 0, authorization };

      // ---- single completion guard: every request answers exactly once ----
      let settled = false;
      let recorded = false;
      let receivedBytes = 0;
      let sentBytes = 0;
      let upstreamReq: ClientRequest | null = null;
      let finishedStreaming = false;
      const record = (): void => {
        if (recorded) return;
        recorded = true;
        entry.index = evidence.length + 1;
        evidence.push(entry);
      };
      const fail = (status: number, forwardError: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimer();
        record();
        entry.status = status;
        if (forwardError) entry.forwardError = true;
        if (!res.headersSent) {
          // A bridge-side refusal ends the connection: the request stream is
          // aborted mid-flight, so the socket can never be reused — and the
          // client must learn that from THIS response, not a poisoned socket.
          res.writeHead(status, { "content-type": "application/json", connection: "close" });
          res.end(forwardError ? JSON.stringify({ error: "origin bridge could not reach the upstream target" }) : undefined);
          res.once("finish", () => {
            try {
              req.destroy();
            } catch { /* already gone */ }
          });
        } else {
          res.end();
        }
        upstreamReq?.destroy();
      };
      const timer = setTimeout(() => {
        if (!settled) {
          fail(502, true);
        } else if (!finishedStreaming) {
          // timed out mid-response: the only completion is a forward failure
          entry.forwardError = true;
          try {
            res.destroy();
          } catch { /* already gone */ }
          upstreamReq?.destroy();
        }
      }, BRIDGE_REQUEST_TIMEOUT_MS);
      const clearTimer = (): void => clearTimeout(timer);

      // Client hung up: never answer twice, never leak the upstream socket.
      res.on("close", () => {
        if (finishedStreaming) return;
        if (!settled) {
          settled = true;
          clearTimer();
          entry.status = 0;
          entry.clientAborted = true;
          record();
        }
        upstreamReq?.destroy();
      });

      if (headerBytes > MAX_HEADER_BYTES) {
        settled = true;
        clearTimer();
        record();
        entry.status = 431;
        res.writeHead(431, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request headers exceed the bridge bound" }));
        return;
      }

      const forwardHeaders = stripHopByHop(req.headers as Record<string, string | string[] | undefined>);
      delete forwardHeaders.host;
      forwardHeaders.host = upstream.host;

      const requestFn = upstream.protocol === "https:" ? httpsRequest : httpRequest;
      upstreamReq = requestFn(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port === "" ? (upstream.protocol === "https:" ? 443 : 80) : Number(upstream.port),
          path: rawUrl, // path AND query preserved verbatim
          method,
          headers: forwardHeaders,
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 502;
          if (settled) {
            // a bridge-side answer (413/431/400/…) already went out — discard
            upstreamRes.resume();
            return;
          }
          settled = true;
          clearTimer();
          record();
          entry.status = status;
          res.writeHead(status, stripHopByHop(upstreamRes.headers as Record<string, string | string[] | undefined>));
          upstreamRes.on("data", (chunk: Buffer) => {
            if (finishedStreaming) return;
            sentBytes += chunk.length;
            if (sentBytes > MAX_RESPONSE_BODY_BYTES) {
              // over the response bound: the forward cannot complete cleanly
              entry.forwardError = true;
              finishedStreaming = true;
              clearTimer();
              try {
                res.destroy();
              } catch { /* already gone */ }
              upstreamReq?.destroy();
              return;
            }
            if (!res.write(chunk)) {
              upstreamRes.pause(); // backpressure: wait for the client to drain
              res.once("drain", () => upstreamRes.resume());
            }
          });
          upstreamRes.on("end", () => {
            if (finishedStreaming) return;
            finishedStreaming = true;
            clearTimer();
            res.end();
          });
          upstreamRes.on("error", () => {
            if (finishedStreaming) return;
            finishedStreaming = true;
            clearTimer();
            entry.forwardError = true;
            try {
              res.destroy();
            } catch { /* already gone */ }
          });
          upstreamRes.on("aborted", () => {
            if (finishedStreaming) return;
            finishedStreaming = true;
            clearTimer();
            entry.forwardError = true;
            try {
              res.destroy();
            } catch { /* already gone */ }
          });
        },
      );
      upstreamReq.on("error", () => fail(502, true));

      // ---- bounded request-body streaming with explicit backpressure ----
      req.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
          fail(413, false); // bridge-side size refusal, not a forward error (fail() closes the connection after the response flushes)
          return;
        }
        if (settled || !upstreamReq) return;
        if (!upstreamReq.write(chunk)) {
          req.pause(); // backpressure: wait for the upstream socket to drain
          upstreamReq.once("drain", () => req.resume());
        }
      });
      req.on("end", () => {
        if (settled || !upstreamReq) return;
        upstreamReq.end();
      });
      req.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimer();
        record();
        entry.status = 400;
        entry.clientAborted = true;
        try {
          res.destroy();
        } catch { /* already gone */ }
        upstreamReq?.destroy();
      });
    };

    // The server constructor loads the key/cert into memory. Immediately
    // after that — before candidate execution begins — delete the CA and
    // leaf private keys, the CSR, and the OpenSSL configuration from disk.
    // Every deletion is attempted even if an earlier one fails.
    const server: Server = createHttpsServer({ key, cert }, handle);
    await Promise.allSettled([rm(cfg, { force: true }), rm(caKey, { force: true }), rm(leafKey, { force: true }), rm(leafCsr, { force: true })]);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("origin bridge: no port after listen");

    return {
      origin: `https://127.0.0.1:${addr.port}`,
      caPath: caCert,
      materialDir: dir,
      evidence,
      close: async () => {
        if (closed) return;
        closed = true;
        // Run every teardown step even if one of them fails.
        await Promise.allSettled([
          (async () => {
            server.closeAllConnections?.();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          })(),
          rm(dir, { recursive: true, force: true }),
        ]);
      },
    };
  } catch (error) {
    // Setup failure: run the full directory cleanup before rethrowing.
    await Promise.allSettled([rm(dir, { recursive: true, force: true })]);
    if (error instanceof Error && error.message.startsWith("openssl failed")) throw error;
    throw new Error(`origin bridge could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}
