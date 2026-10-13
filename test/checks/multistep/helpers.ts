// Locally constructed Multistep fixtures — mechanics proof ONLY.
// Every value is synthetic: no raw Mac asset, no real account, no real token,
// no signed URL, no provider credential ever enters this repository.

export const FAKE_ACCOUNT = "user-fixture-001";
export const FAKE_TOKEN = "tok-fixture-0001abcdefXYZ";
export const FAKE_ORIGIN = "https://multistep-fixture.example";
export const SELECTED_SLOT = "09:30";

type Json = Record<string, unknown>;

function requestStep(title: string, checklyData: unknown): Json {
  // Real downloaded assets carry `checklyData` as a (possibly nested) ARRAY
  // of records, array-form headers, `requestBody: { data: … }`, and the real
  // response body field `body`.
  return { title, category: "api", startTime: 1, duration: 5, checklyData };
}

function step(title: string, children: Json[], error?: Json): Json {
  return { title, category: "test.step", startTime: 1, duration: 5, ...(error ? { error } : {}), steps: children };
}

function assertion(expected: unknown, actual: unknown): Json {
  return { title: "expect.toBe", category: "expect", checklyData: [{ expected, actual }] };
}

function loginStep(): Json {
  return step("login", [
    requestStep("POST /api/login", [
      {
        requestTitle: "POST /api/login",
        fetchUid: "fetch-1",
        method: "POST",
        url: `${FAKE_ORIGIN}/api/login`,
        requestHeaders: [["content-type", "application/json"]],
        requestBody: { data: { account: FAKE_ACCOUNT } },
        status: 200,
        statusText: "OK",
        responseHeaders: [["content-type", "application/json"]],
        body: { ok: true, account: FAKE_ACCOUNT, version: 1, token: FAKE_TOKEN, store: "memory" },
        timings: { startTime: 1, endTime: 2 },
      },
    ]),
    assertion(true, true),
  ]);
}

function sessionStep(): Json {
  return step("session", [
    requestStep("GET /api/session", [
      {
        requestTitle: "GET /api/session",
        fetchUid: "fetch-2",
        method: "GET",
        url: `${FAKE_ORIGIN}/api/session`,
        requestHeaders: [["authorization", `Bearer ${FAKE_TOKEN}`]],
        requestBody: null,
        status: 200,
        statusText: "OK",
        responseHeaders: [["content-type", "application/json"]],
        body: { valid: true, account: FAKE_ACCOUNT, tokenVersion: 1, currentVersion: 1 },
        timings: { startTime: 3, endTime: 4 },
      },
    ]),
    assertion(true, true),
  ]);
}

function slotsStep(): Json {
  return step("slots", [
    requestStep("GET /api/slots", [
      {
        requestTitle: "GET /api/slots",
        fetchUid: "fetch-3",
        method: "GET",
        url: `${FAKE_ORIGIN}/api/slots`,
        requestHeaders: [],
        requestBody: null,
        status: 200,
        statusText: "OK",
        responseHeaders: [["content-type", "application/json"]],
        body: { delayMs: 1500, slots: [SELECTED_SLOT, "10:00", "11:30"] },
        timings: { startTime: 5, endTime: 6 },
      },
    ]),
    assertion("09:30", "09:30"),
  ]);
}

/** Flat (pre-incident) book response — the passing baseline. */
/**
 * Nested (healthy) book response with the nested assertion passing.
 *
 * The application ALWAYS returns the nested `booking` object, so a PASSING run
 * against it records a nested body — exactly like the failing run. A passing
 * capture validated against a flat historical shape is inadmissible, which is
 * why the flat variant below is retained only as a negative fixture.
 */
function bookStepNestedPassing(): Json {
  const request = requestStep("POST /api/book", [
    {
      requestTitle: "POST /api/book",
      fetchUid: "fetch-4",
      method: "POST",
      url: `${FAKE_ORIGIN}/api/book`,
      requestHeaders: [["authorization", `Bearer ${FAKE_TOKEN}`], ["content-type", "application/json"]],
      requestBody: { data: { slot: SELECTED_SLOT } },
      status: 200,
      statusText: "OK",
      responseHeaders: [["content-type", "application/json"]],
      body: { booking: { confirmed: true, status: "CONFIRMED", account: FAKE_ACCOUNT, slot: SELECTED_SLOT, sessionVersion: 1 } },
      timings: { startTime: 7, endTime: 8 },
    },
  ]);
  return step("book 09:30", [request, assertion(true, true)]);
}

/** Nested (incident) book response with the stale assertion failing. */
function bookStepNestedFailing(): Json {
  const request = requestStep("POST /api/book", [
    {
      requestTitle: "POST /api/book",
      fetchUid: "fetch-4",
      method: "POST",
      url: `${FAKE_ORIGIN}/api/book`,
      requestHeaders: [["authorization", `Bearer ${FAKE_TOKEN}`], ["content-type", "application/json"]],
      requestBody: { data: { slot: SELECTED_SLOT } },
      status: 200,
      statusText: "OK",
      responseHeaders: [["content-type", "application/json"]],
      body: { booking: { confirmed: true, status: "CONFIRMED", account: FAKE_ACCOUNT, slot: SELECTED_SLOT, sessionVersion: 1 } },
      // first stale flat-contract assertion: expect(body.confirmed).toBe(true)
      expected: true,
      actual: null,
      timings: { startTime: 7, endTime: 8 },
    },
  ]);
  const failingAssert = {
    title: "expect.toBe",
    category: "expect",
    error: {
      message: "Error: expect(received).toBe(expected)\nReceived:    undefined\n    at book 09:30 (multistep-booking.spec.ts:142:24)",
      stack: "Error: expect(received).toBe(expected)",
    },
  };
  return step("book 09:30", [request, failingAssert]);
}

function confirmStep(): Json {
  return step("confirm transaction", [
    {
      title: "expect.toBe",
      category: "expect",
      checklyData: [{ requestTitle: "cross-step bookingResult", expected: "CONFIRMED", actual: "CONFIRMED" }],
    },
  ]);
}

function hasDeepError(steps: Json[]): boolean {
  return steps.some((s) => Boolean(s.error) || (Array.isArray(s.steps) && hasDeepError(s.steps as Json[])));
}

function report(stats: Json, steps: Json[]): string {
  return JSON.stringify({
    config: { rootDir: "/", testDir: ".", reporter: "json" },
    errors: [],
    stats,
    suites: [
      {
        title: "multistep-booking.spec.ts",
        suites: [
          {
            title: "slots booking multistep transaction",
            specs: [
              {
                title: "slots booking multistep transaction",
                file: "checks/multistep-booking.spec.ts",
                line: 66,
                column: 1,
                tests: [{ projectName: "chromium", results: [{ status: hasDeepError(steps) ? "failed" : "passed", steps }] }],
              },
            ],
          },
        ],
      },
    ],
  });
}

/** Passing real-shape capture: five ordered steps, expected 1 / unexpected 0. */
export function passingTestResults(): string {
  return report(
    { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    [loginStep(), sessionStep(), slotsStep(), bookStepNestedPassing(), confirmStep()],
  );
}

/** Failing real-shape capture: four steps, book fails, confirm absent. */
export function failingTestResults(): string {
  return report(
    { expected: 0, unexpected: 1, flaky: 0, skipped: 0 },
    [loginStep(), sessionStep(), slotsStep(), bookStepNestedFailing()],
  );
}

export function passingLogs(): string {
  return JSON.stringify([
    { level: "DEBUG", msg: "multistep run started", time: 1758800000000 },
    { level: "INFO", msg: "all five canonical steps passed", time: 1758800001000 },
  ]);
}

export function failingLogs(): string {
  return JSON.stringify([
    { level: "DEBUG", msg: "multistep run started", time: 1758801000000 },
    { level: "INFO", msg: "stale contract assertion failed inside book 09:30", time: 1758801002000 },
  ]);
}

/** Full optional fields. */
export function fullCheckRunData(): string {
  return JSON.stringify({
    dependencies: { "@playwright/test": "1.50.0" },
    imports: [{ path: "checks/multistep-booking.spec.ts" }],
    playwrightConfig: { testDir: "." },
    script: "// synthetic script content\nexport {}\n",
    scriptPath: "checks/multistep-booking.spec.ts",
  });
}

/** Minimal optional fields — a failing capture may carry only these. */
export function minimalCheckRunData(): string {
  return JSON.stringify({
    script: "// synthetic script content\nexport {}\n",
    scriptPath: "checks/multistep-booking.spec.ts",
  });
}
