import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMultistepScenario } from "../../src/capture/bundle/scenario.ts";
import { deriveMultiStepScenario } from "../../src/capture/bundle/manifest.ts";
import type { MultiStepCapture } from "../../src/checks/multistep/normalize.ts";
import { multistepWitnessProblems } from "../../src/checks/multistep/shape.ts";

const valid = {
  kind: "multistep",
  routes: [
    { method: "POST", path: "/api/login", step: "login" },
    { method: "GET", path: "/api/session", step: "session", auth: true },
    { method: "GET", path: "/api/slots", step: "slots" },
    { method: "POST", path: "/api/book", step: "book 09:30", auth: true },
  ],
  stepTitles: ["login", "session", "slots", "book 09:30", "confirm transaction"],
  mutation: { method: "POST", path: "/api/book", jsonPath: ["booking", "confirmed"], expected: true, replace: false },
  slot: "09:30",
  repair: [
    { from: "body.confirmed", to: "body.booking.confirmed" },
    { from: "body.booking", to: "body.booking.status" },
    { from: "typeof body.account", to: "typeof body.booking.account" },
    { from: "body.account", to: "body.booking.account" },
    { from: "body.slot", to: "body.booking.slot" },
    { from: "body.version", to: "body.booking.sessionVersion" },
  ],
  writes: [
    { from: "write:bookingAccount:=:body.account as string", to: "write:bookingAccount:=:body.booking.account as string" },
    { from: "write:bookingSlot:=:body.slot as string", to: "write:bookingSlot:=:body.booking.slot as string" },
    { from: "write:bookingVersion:=:body.version as number", to: "write:bookingVersion:=:body.booking.sessionVersion as number" },
    { from: "write:bookingConfirmed:=:body.confirmed === true", to: "write:bookingConfirmed:=:body.booking.confirmed === true" },
    { from: "write:bookingResult:=:body.booking as string", to: "write:bookingResult:=:body.booking.status as string" },
  ],
};

test("a complete Multistep scenario validates without rewriting", () => {
  const result = validateMultistepScenario(valid);
  assert.equal(result.problem, null);
  assert.deepEqual(result.scenario, valid);
});

test("a scenario with an unknown key, external path, or non-scalar mutation is rejected", () => {
  const withExtra = { ...valid, surprise: true };
  const external = { ...valid, routes: [{ method: "GET", path: "https://evil.example/api", step: "x" }], stepTitles: ["x"] };
  const query = { ...valid, routes: [{ method: "GET", path: "/api/slots?x=1", step: "slots" }], stepTitles: ["slots"] };
  const arrayMutation = { ...valid, mutation: { ...valid.mutation, replace: [false] } };
  const sameValue = { ...valid, mutation: { ...valid.mutation, replace: true } };
  const wrongRoute = { ...valid, mutation: { ...valid.mutation, path: "/api/other" } };
  for (const candidate of [withExtra, external, query, arrayMutation, sameValue, wrongRoute, null, [], "scenario"]) {
    assert.equal(validateMultistepScenario(candidate).scenario, null, JSON.stringify(candidate));
    assert.equal(validateMultistepScenario(candidate).problem, "MULTISTEP_SCENARIO_INVALID");
  }
});

test("capture derives routes, titles and the single boolean mutation from evidence", () => {
  const capture: MultiStepCapture = {
    kind: "failing", stats: null, reporterStatus: "failed", reporterErrors: 0,
    steps: [
      { title: "login", status: "passed", error: null, requests: [{ method: "POST", path: "/auth/login", queryKeys: [], status: 200, responseBody: { ok: true }, requestBody: {}, title: null, url: null, statusText: null, responseHeaders: {}, requestHeaders: {}, expected: null, actual: null, timings: null, fetchUid: null }], assertions: [] },
      { title: "cart", status: "failed", error: "ASSERTION_FAILED", requests: [{ method: "POST", path: "/auth/cart", queryKeys: [], status: 200, responseBody: { order: { state: "open", paid: true } }, requestBody: {}, title: null, url: null, statusText: null, responseHeaders: {}, requestHeaders: {}, expected: null, actual: null, timings: null, fetchUid: null }], assertions: [] },
    ],
    checkRunData: null, logs: null, recurrence: { attempts: 1 }, problems: [],
  };
  const scenario = deriveMultiStepScenario(capture);
  assert.deepEqual(scenario, {
    kind: "multistep",
    routes: [
      { method: "POST", path: "/auth/login", step: "login" },
      { method: "POST", path: "/auth/cart", step: "cart" },
    ],
    stepTitles: ["login", "cart"],
    mutation: { method: "POST", path: "/auth/cart", jsonPath: ["order", "paid"], expected: true, replace: false },
    repair: [
      { from: "body.state", to: "body.order.state" },
      { from: "typeof body.state", to: "typeof body.order.state" },
      { from: "body.paid", to: "body.order.paid" },
      { from: "typeof body.paid", to: "typeof body.order.paid" },
    ],
    witness: {
      responses: [
        { kind: "object", fields: { ok: { kind: "boolean" } } },
        { kind: "object", fields: { order: { kind: "object", fields: {
          state: { kind: "string" }, paid: { kind: "boolean" } } } } },
      ],
      equalities: [{
        left: { route: 0, where: "response", path: ["ok"] },
        right: { route: 1, where: "response", path: ["order", "paid"] },
      }],
    },
  });
  assert.equal(deriveMultiStepScenario(null), null);
});

test("the values-free witness is route-agnostic and rejects changed structure or relationships", () => {
  const request = (method: string, path: string, responseBody: Record<string, unknown>, requestBody: unknown = {}) => ({
    method, path, queryKeys: [], status: 200, responseBody, requestBody, title: null, url: null,
    statusText: null, responseHeaders: {}, requestHeaders: {}, expected: null, actual: null, timings: null, fetchUid: null,
  });
  const capture: MultiStepCapture = {
    kind: "failing", stats: null, reporterStatus: "failed", reporterErrors: 0,
    steps: [
      { title: "sign in", status: "passed", error: null,
        requests: [request("POST", "/auth/login", { ok: true, session: { id: "s-1" } }, { user: "u-1" })], assertions: [] },
      { title: "cart", status: "failed", error: "ASSERTION_FAILED",
        requests: [request("POST", "/auth/cart", { order: { state: "open", paid: true, session: "s-1" } })], assertions: [] },
    ],
    checkRunData: null, logs: null, recurrence: { attempts: 1 }, problems: [],
  };
  const scenario = deriveMultiStepScenario(capture)!;
  assert.deepEqual(multistepWitnessProblems(scenario, capture), []);
  const extra = structuredClone(capture);
  (extra.steps[1]!.requests[0]!.responseBody as { order: Record<string, unknown> }).order.extra = true;
  assert.deepEqual(multistepWitnessProblems(scenario, extra), ["MULTISTEP_REQUEST_BODY_INVALID"]);
  const changed = structuredClone(capture);
  (changed.steps[1]!.requests[0]!.responseBody as { order: { paid: boolean } }).order.paid = false;
  assert.deepEqual(multistepWitnessProblems(scenario, changed), ["MULTISTEP_TRANSACTION_RELATIONSHIP_INVALID"]);
});
