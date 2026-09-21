import { createServer, type Server } from "node:http";
import type { Scene } from "../../../../../src/types.ts";
import type { AppSim } from "../../../../../src/executor/synthetic.ts";

// Deterministic app simulator for the slots-booking app-under-test.
// Faithful to the one-session-per-account invariant (the 3-vs-18 queues /
// Laura Guo feedback scenario): a second login for an account invalidates the
// first session, so an overlapping run's later step gets 401.
//
// Scene states (driven deterministically):
//   HEALTHY / REGRESSION  → normal one-session semantics, book allowed
//   REPRODUCTION          → 'phantom-overlap' armed: after the check's own
//                           login commits, a phantom overlapping run logs in
//                           again (unless the check holds the serialization
//                           lock), so the check's booking step deterministically
//                           gets 401 unless the candidate serializes runs.
//   DETECTION             → forced real failure: booking always 401.

interface Account {
  version: number;
  lockHolders: number; // 0 or 1 (per-check serialization guard)
}

export default async function create(): Promise<AppSim> {
  const accounts = new Map<string, Account>();
  const getAcct = (a: string): Account => {
    let x = accounts.get(a);
    if (!x) {
      x = { version: 0, lockHolders: 0 };
      accounts.set(a, x);
    }
    return x;
  };

  let mode: "normal" | "overlap" | "auth-fail" = "normal";
  let server: Server;
  const readBody = (req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (d: Buffer) => (data += String(d)));
      req.on("end", () => {
        try {
          resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });

  const json = (res: import("node:http").ServerResponse, code: number, obj: Record<string, unknown>) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readBody(req);
    const acct = String(body.account ?? url.searchParams.get("account") ?? "");

    if (url.pathname === "/login") {
      if (!acct) {
        json(res, 400, { error: "account required" });
        return;
      }
      const a = getAcct(acct);
      // NOTE: auth-fail does NOT break login — the DETECTION scene breaks the
      // *protected behavior* (booking, below). A detection state that broke
      // login would only ever test the check's weakest step.
      a.version += 1; // this login is now the newest session
      const myToken = `tok-${acct}-${a.version}`;
      if (mode === "overlap" && a.lockHolders === 0) {
        // phantom overlapping run logs in immediately after ours → our session
        // is superseded before we can book (mirrors the recorded 401).
        a.version += 1;
        json(res, 200, { token: myToken, superseded: true });
        return;
      }
      json(res, 200, { token: myToken });
      return;
    }

    if (url.pathname === "/lock") {
      const a = getAcct(acct);
      // acquire-or-wait queue: only one holder (serialization guard). This is
      // the primitive a per-check max-concurrency fix plugs into.
      const mine = Symbol();
      a.lockHolders += 1;
      await new Promise<void>((resolve) => {
        const poll = () => (a.lockHolders === 1 ? resolve() : setTimeout(poll, 2));
        poll();
      });
      json(res, 200, { acquired: true, token: mine.toString() });
      return;
    }

    if (url.pathname === "/unlock") {
      const a = getAcct(acct);
      a.lockHolders = Math.max(0, a.lockHolders - 1);
      json(res, 200, { released: true });
      return;
    }

    if (url.pathname === "/book") {
      if (mode === "auth-fail") {
        // forced real failure: the protected behavior is broken for everyone
        json(res, 401, { error: "forced auth failure" });
        return;
      }
      // The booking request carries no account field (the real check sends
      // only {slot}); the session is identified by the bearer token, which
      // encodes account + session version: tok-<account>-<version>.
      const auth = String(req.headers.authorization ?? "");
      const token = auth.replace(/^Bearer\s+/, "");
      const parsed = /^tok-(.+)-(\d+)$/.exec(token);
      if (!parsed) {
        json(res, 401, { error: "missing or malformed session token" });
        return;
      }
      const tokenAcct = parsed[1];
      const a = getAcct(tokenAcct);
      const mine = Number(parsed[2]) === a.version;
      if (!mine) {
        json(res, 401, { error: "session superseded by an overlapping run" });
        return;
      }
      json(res, 200, { confirmed: true, booking: "CONFIRMED", slot: String(body.slot ?? "09:30") });
      return;
    }

    json(res, 404, { error: "not found" });
  });

  return {
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      if (addr && typeof addr === "object") {
        return Promise.resolve(`http://127.0.0.1:${addr.port}`);
      }
      throw new Error("no port");
    },
    async drive(scene: Scene) {
      mode = "normal";
      accounts.clear();
      const kind = scene.stateDriver?.params?.mode ?? "normal";
      if (kind === "overlap") mode = "overlap";
      if (kind === "auth-fail") mode = "auth-fail";
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}