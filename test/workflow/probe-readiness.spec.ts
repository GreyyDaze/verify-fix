import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTECTION_BYPASS_HEADER,
  runReadinessProbe,
} from "../../.github/helpers/probe-readiness.mjs";
import { MAX_HEALTH_BODY_BYTES } from "../../.github/helpers/readiness.mjs";

const ORIGIN = "https://monitoring.example.org";
const HEALTH_URL = "https://monitoring.example.org/api/health";
const BYPASS_VALUE = "s3cr3t-bypass-value";

const HEALTH_BODY = JSON.stringify({
  ok: true,
  store: "inmemory",
  slotLoadDelayMs: 0,
});

type RecordedCall = {
  url: string;
  redirect: unknown;
  bypassHeader: string | undefined;
};

type Step = { status: number; body: string };

/** Builds an injected fetch that replays `steps` (last step repeats), recording calls. */
function makeFetch(steps: Step[]) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      redirect: init.redirect,
      bypassHeader: headers[PROTECTION_BYPASS_HEADER],
    });
    const step = steps[Math.min(index, steps.length - 1)]!;
    index += 1;
    // A real Response so the probe reads a real body stream (bounded).
    return new Response(step.body, { status: step.status });
  };
  return { calls, fetchImpl };
}

const noopSleep = async (): Promise<void> => {};

test("public 200 + valid health is ready and the bypass header is never sent", async () => {
  const { calls, fetchImpl } = makeFetch([{ status: 200, body: HEALTH_BODY }]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, true);
  assert.equal(outcome.reason, "public-health-ok");
  assert.equal(outcome.bypassUsed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, HEALTH_URL);
  assert.equal(calls[0]!.bypassHeader, undefined);
  assert.equal(calls[0]!.redirect, "manual");
});

test("public 200 + valid health is ready without any bypass value", async () => {
  const { calls, fetchImpl } = makeFetch([{ status: 200, body: HEALTH_BODY }]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: "",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, true);
  assert.equal(outcome.bypassUsed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.bypassHeader, undefined);
});

test("an initial 302 is never accepted as readiness", async () => {
  const { calls, fetchImpl } = makeFetch([{ status: 302, body: "<html>sign-in</html>" }]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 2,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.ok(!outcome.reason.includes(BYPASS_VALUE));
  // first call public (no bypass), second with bypass still 302 → fail.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.bypassHeader, undefined);
  assert.equal(calls[1]!.bypassHeader, BYPASS_VALUE);
  assert.equal(calls[1]!.url, HEALTH_URL);
});

test("302 without a bypass value fails closed", async () => {
  const { calls, fetchImpl } = makeFetch([{ status: 302, body: "" }]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: "",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 5,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "protected-no-bypass-available");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.bypassHeader, undefined);
});

test("302 then 200 + valid health with bypass succeeds", async () => {
  const { calls, fetchImpl } = makeFetch([
    { status: 302, body: "" },
    { status: 200, body: HEALTH_BODY },
  ]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, true);
  assert.equal(outcome.reason, "bypass-health-ok");
  assert.equal(outcome.bypassUsed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.bypassHeader, undefined);
  assert.equal(calls[1]!.bypassHeader, BYPASS_VALUE);
  assert.equal(calls[0]!.url, HEALTH_URL);
  assert.equal(calls[1]!.url, HEALTH_URL);
  assert.equal(calls[0]!.redirect, "manual");
  assert.equal(calls[1]!.redirect, "manual");
});

test("302 then 302 fails — never readiness", async () => {
  const { calls, fetchImpl } = makeFetch([
    { status: 302, body: "" },
    { status: 302, body: "" },
    { status: 200, body: HEALTH_BODY },
  ]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "protected-after-bypass");
  // The third (ready) response is never reached after the second 302.
  assert.equal(calls.length, 2);
});

test("401 protection follows the same public-first boundary", async () => {
  const { calls, fetchImpl } = makeFetch([
    { status: 401, body: "" },
    { status: 200, body: HEALTH_BODY },
  ]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, true);
  assert.equal(outcome.reason, "bypass-health-ok");
  assert.equal(calls[0]!.bypassHeader, undefined);
  assert.equal(calls[1]!.bypassHeader, BYPASS_VALUE);

  const noBypass = makeFetch([{ status: 401, body: "" }]);
  const denied = await runReadinessProbe({
    origin: ORIGIN,
    bypass: "",
    fetchImpl: noBypass.fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(denied.ready, false);
  assert.equal(denied.reason, "protected-no-bypass-available");
  assert.equal(noBypass.calls.length, 1);
});

test("403 protection follows the same public-first boundary", async () => {
  const { calls, fetchImpl } = makeFetch([
    { status: 403, body: "" },
    { status: 200, body: HEALTH_BODY },
  ]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, true);
  assert.equal(outcome.reason, "bypass-health-ok");
  assert.equal(calls[0]!.bypassHeader, undefined);

  const secondProtection = makeFetch([
    { status: 403, body: "" },
    { status: 403, body: "" },
  ]);
  const failed = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: secondProtection.fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(failed.ready, false);
  assert.equal(failed.reason, "protected-after-bypass");
  assert.equal(secondProtection.calls.length, 2);
});

test("invalid health JSON after bypass still fails", async () => {
  const { fetchImpl } = makeFetch([
    { status: 302, body: "" },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 2,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "bypass-not-ready");
});

test("retries stay on the same validated origin and never redirect", async () => {
  const { calls, fetchImpl } = makeFetch([
    { status: 404, body: "" },
    { status: 200, body: HEALTH_BODY },
  ]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: "",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, HEALTH_URL);
    assert.equal(call.redirect, "manual");
  }
});

test("transport failures (e.g. timeouts) fail closed without hanging", async () => {
  let attemptsMade = 0;
  const fetchImpl = (async (): Promise<Response> => {
    attemptsMade += 1;
    throw new Error("operation timed out");
  }) as unknown as typeof fetch;
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "public-not-ready");
  assert.equal(attemptsMade, 3);
});

test("public 404s exhaust the budget without ever sending bypass", async () => {
  const { calls, fetchImpl } = makeFetch([{ status: 404, body: "" }]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "public-not-ready");
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.bypassHeader, undefined);
});

test("an oversized public response makes exactly one request, is never retried, and never sends the bypass", async () => {
  const hugeBody = `{"ok":true,"pad":"${"x".repeat(70000)}"}`;
  let sleepCount = 0;
  const { calls, fetchImpl } = makeFetch([{ status: 200, body: hugeBody }]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: async () => {
      sleepCount += 1;
    },
    attempts: 5,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "health-body-too-large");
  assert.equal(calls.length, 1, "an oversized response is definitive: exactly one request, no retry");
  assert.equal(sleepCount, 0, "an oversized response must never sleep");
  assert.equal(outcome.bypassUsed, false, "public probing must not transition to bypass probing");
  for (const call of calls) assert.equal(call.bypassHeader, undefined, "no bypass request may be made");
});

test("health URL is derived with the URL API, not string concatenation", async () => {
  const { calls, fetchImpl } = makeFetch([{ status: 200, body: HEALTH_BODY }]);
  await runReadinessProbe({
    origin: `${ORIGIN}/`,
    bypass: "",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: noopSleep,
    attempts: 1,
    delayMs: 0,
  });
  assert.equal(calls[0]!.url, HEALTH_URL);
});

test("streamed content crossing the bound is cancelled and response.text() is never called", async () => {
  const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
  let pulledBytes = 0;
  const infiniteStream = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulledBytes += chunk.byteLength;
        if (pulledBytes > 10 * 1024 * 1024) {
          controller.error(new Error("stream read far past the byte bound"));
          return;
        }
        controller.enqueue(chunk);
      },
    });
  let textCalled = false;
  const fetchImpl = (async () => ({
    status: 200,
    headers: { get: (): string | null => null },
    body: infiniteStream(),
    text: async () => {
      textCalled = true;
      throw new Error("response.text() must never be called on a health response");
    },
  })) as unknown as typeof fetch;
  let sleepCount = 0;
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl,
    sleepImpl: async () => {
      sleepCount += 1;
    },
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "health-body-too-large");
  assert.equal(outcome.bypassUsed, false);
  assert.equal(textCalled, false, "response.text() must never be called");
  assert.equal(sleepCount, 0, "an oversized response must never sleep or retry");
  // The reader stops at the bound: at most one chunk crosses it plus at most
  // one chunk already sitting in the stream's internal queue (default
  // high-water mark 1) — and never anything close to the 10 MiB on offer.
  assert.ok(
    pulledBytes <= MAX_HEALTH_BODY_BYTES + 2 * chunk.byteLength,
    `stream must stop at the bound; pulled ${pulledBytes} bytes`,
  );
  assert.ok(pulledBytes < 1024 * 1024, `only the bounded prefix may be read; pulled ${pulledBytes} bytes`);
  assert.ok(pulledBytes > 0, "the stream must actually have been read");
});

test("an oversized Content-Length rejects before the body is consumed", async () => {
  let pulledBytes = 0;
  let fetchCalls = 0;
  // highWaterMark 0: no byte is pulled until read() is actually demanded.
  const countingStream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulledBytes += 8192;
        controller.enqueue(new Uint8Array(8192));
      },
    },
    { highWaterMark: 0 },
  );
  const response = {
    status: 200,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === "content-length" ? String(MAX_HEALTH_BODY_BYTES + 1) : null,
    },
    body: countingStream,
    text: async () => {
      throw new Error("response.text() must never be called");
    },
  } as unknown as Response;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return response;
  }) as unknown as typeof fetch;
  let sleepCount = 0;
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl,
    sleepImpl: async () => {
      sleepCount += 1;
    },
    attempts: 5,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "health-body-too-large");
  assert.equal(pulledBytes, 0, "the body must not be consumed when Content-Length already exceeds the bound");
  assert.equal(fetchCalls, 1, "definitive: exactly one request");
  assert.equal(sleepCount, 0, "definitive: no sleep, no retry");
  assert.equal(outcome.bypassUsed, false, "never transitions to bypass probing");
});

test("malformed, negative, non-integer, and unsafe Content-Length values reject with a stable reason", async () => {
  const badValues = ["abc", "-1", "12.5", "1e3", "+5", "", "12 34", "NaN", "99999999999999999999"];
  for (const raw of badValues) {
    let pulledBytes = 0;
    let fetchCalls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulledBytes += 1024;
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    const response = {
      status: 200,
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === "content-length" ? raw : null,
      },
      body: stream,
      text: async () => {
        throw new Error("response.text() must never be called");
      },
    } as unknown as Response;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return response;
    }) as unknown as typeof fetch;
    let sleepCount = 0;
    const outcome = await runReadinessProbe({
      origin: ORIGIN,
      bypass: "",
      fetchImpl,
      sleepImpl: async () => {
        sleepCount += 1;
      },
      attempts: 3,
      delayMs: 0,
    });
    assert.equal(outcome.ready, false, raw);
    assert.equal(outcome.reason, "health-content-length-invalid", raw);
    assert.equal(pulledBytes, 0, `body must not be consumed for invalid Content-Length: ${raw}`);
    assert.equal(fetchCalls, 1, `definitive: exactly one request for ${raw}`);
    assert.equal(sleepCount, 0, `definitive: no sleep for ${raw}`);
  }
});

test("multibyte UTF-8 response bodies are counted by bytes, not string characters", async () => {
  // 40,000 'é' characters = 40,000 JS characters (< 64 KiB) but 80,000
  // UTF-8 bytes (> 64 KiB) — the byte count must trip the bound.
  const multibyte = "é".repeat(40000);
  let sleepCount = 0;
  const { calls, fetchImpl } = makeFetch([{ status: 200, body: multibyte }]);
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: async () => {
      sleepCount += 1;
    },
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "health-body-too-large");
  assert.equal(calls.length, 1, "definitive: exactly one request");
  assert.equal(sleepCount, 0, "definitive: no sleep");
  assert.equal(outcome.bypassUsed, false);
  for (const call of calls) assert.equal(call.bypassHeader, undefined);
});

test("an oversized response during the bypass phase stops immediately", async () => {
  let fetchCalls = 0;
  const bypassHeaders: (string | undefined)[] = [];
  let sleepCount = 0;
  let pulledBytes = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    fetchCalls += 1;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    bypassHeaders.push(headers[PROTECTION_BYPASS_HEADER]);
    if (fetchCalls === 1) return new Response("<html>sign-in</html>", { status: 302 });
    return {
      status: 200,
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === "content-length" ? String(MAX_HEALTH_BODY_BYTES * 2) : null,
      },
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulledBytes += 1024;
            controller.enqueue(new Uint8Array(1024));
          },
        },
        { highWaterMark: 0 },
      ),
      text: async () => {
        throw new Error("response.text() must never be called");
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: BYPASS_VALUE,
    fetchImpl,
    sleepImpl: async () => {
      sleepCount += 1;
    },
    attempts: 5,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "health-body-too-large");
  assert.equal(outcome.bypassUsed, true, "the oversized response happened during bypass probing");
  assert.equal(fetchCalls, 2, "302 then one oversized bypass request — no further requests");
  assert.equal(sleepCount, 0, "definitive during bypass: no sleep, no retry");
  assert.equal(pulledBytes, 0, "the oversized body must not be consumed");
  assert.equal(bypassHeaders[0], undefined, "phase 1 must not send the bypass header");
  assert.equal(bypassHeaders[1], BYPASS_VALUE, "phase 2 sends the bypass header");
});

test("non-200 responses never read or retain the body", async () => {
  let pulledBytes = 0;
  let textCalled = false;
  let fetchCalls = 0;
  const response = {
    status: 302,
    headers: { get: (): string | null => null },
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulledBytes += 1024;
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    ),
    text: async () => {
      textCalled = true;
      throw new Error("response.text() must never be called");
    },
  } as unknown as Response;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return response;
  }) as unknown as typeof fetch;
  const outcome = await runReadinessProbe({
    origin: ORIGIN,
    bypass: "",
    fetchImpl,
    sleepImpl: noopSleep,
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "protected-no-bypass-available");
  assert.equal(pulledBytes, 0, "a non-200 body must never be read");
  assert.equal(textCalled, false, "a non-200 body must never be read via text()");
  assert.equal(fetchCalls, 1, "protection without bypass fails immediately");
});

test("no body content ever appears in outcomes, reasons, or logs", async () => {
  const BODY_CANARY = "BODY-CANARY-ef39-never-log-me";
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]): void => {
    stdoutLines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    stderrLines.push(args.map(String).join(" "));
  };
  try {
    // Oversized body containing the canary.
    const oversized = `{"ok":true,"pad":"${BODY_CANARY}${"x".repeat(70000)}"}`;
    const oversizedRun = makeFetch([{ status: 200, body: oversized }]);
    const oversizedOutcome = await runReadinessProbe({
      origin: ORIGIN,
      bypass: BYPASS_VALUE,
      fetchImpl: oversizedRun.fetchImpl as unknown as typeof fetch,
      sleepImpl: noopSleep,
      attempts: 2,
      delayMs: 0,
    });
    assert.equal(oversizedOutcome.reason, "health-body-too-large");
    assert.ok(!JSON.stringify(oversizedOutcome).includes(BODY_CANARY));

    // Under-bound body containing the canary: shape failure is also stable.
    const invalid = `{"ok":true,"pad":"${BODY_CANARY}"}`;
    const invalidRun = makeFetch([{ status: 200, body: invalid }]);
    const invalidOutcome = await runReadinessProbe({
      origin: ORIGIN,
      bypass: BYPASS_VALUE,
      fetchImpl: invalidRun.fetchImpl as unknown as typeof fetch,
      sleepImpl: noopSleep,
      attempts: 2,
      delayMs: 0,
    });
    // Attempts are exhausted without readiness — the final reason stays the
    // stable budget-exhaustion reason, never body content.
    assert.equal(invalidOutcome.reason, "public-not-ready");
    assert.ok(!JSON.stringify(invalidOutcome).includes(BODY_CANARY));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const observed = [...stdoutLines, ...stderrLines].join("\n");
  assert.ok(!observed.includes(BODY_CANARY), "body content must never appear in logs");
  assert.equal(stdoutLines.length + stderrLines.length, 0, "runReadinessProbe must not log at all");
});
