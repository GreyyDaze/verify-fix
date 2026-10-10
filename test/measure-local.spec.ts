import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { countMeasuredPasses, type MeasurementRecord } from "../src/measure-local.ts";
import type { ManifestV3 } from "../src/bundle/types.ts";

const request = {
  method: "POST", path: "/api/book", status: 401, passingStatus: 200, failureText: null, url: "https://example.test/api/book",
} as NonNullable<ManifestV3["failurePoint"]>["request"];

describe("local determinism result classification", () => {
  test("Multistep measurement counts the actual check result, not its HTTP 200", () => {
    const records = [
      { checkPassed: false, hits: [{ method: "POST", path: "/api/book", status: 200 } as never] },
      { checkPassed: true, hits: [{ method: "POST", path: "/api/book", status: 200 } as never] },
    ] satisfies MeasurementRecord[];
    assert.equal(countMeasuredPasses(records, request, true), 1);
  });

  test("browser measurement keeps its recorded request-status rule", () => {
    const records = [
      { checkPassed: false, hits: [{ method: "POST", path: "/api/book", status: 200 } as never] },
      { checkPassed: false, hits: [{ method: "POST", path: "/api/book", status: 401 } as never] },
    ] satisfies MeasurementRecord[];
    assert.equal(countMeasuredPasses(records, request, false), 1);
  });
});
