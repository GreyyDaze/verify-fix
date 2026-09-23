// Golden test over the REAL drift bundle (fixtures/bundles/slots-booking-drift).
//
// Captured live on 2026-09-23 after the app renamed data-testid "book-status"
// to "booking-status" (commit 7db4681). The check went stale: every location
// fails at spec line 36 with "element(s) not found". Checkly filed these
// failures under the existing 401 error group, so no automatic RCA ran.
//
// The fixture is re-captured as the tool improves. Assertions below hold for
// both states of the RCA: the inherited 401 analysis (first captures) and a
// fresh one created after the run (rca.json carries replacedRca when
// --trigger-rca requested it inside the same capture).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, resultErrors, runOutcome } from "../../src/bundle/manifest.ts";
import { loadRealBundle } from "../helpers/real-bundle.ts";

const { captured, failingResult, passingResult, rcaDoc, historyFile, inputs } = loadRealBundle("slots-booking-drift");
const overlap = loadRealBundle("slots-booking-overlap");

test("golden (drift): a stale check — locator not found at line 36, all responses healthy; detection derived from the dependency", () => {
  const m = buildManifest(inputs());
  assert.equal(m.incident.status, "captured");
  assert.equal(m.incident.title, `slots booking flow: expect(locator).toHaveText(expected) failed — on getByTestId('book-status'), expected "200", element(s) not found`);
  assert.equal(m.results.failing?.id, failingResult.id);
  assert.deepEqual(m.results.failing?.failingTest, { file: "booking.spec.ts", title: "log in and book the 09:30 slot", project: "booking", line: 36, column: 51 });
  assert.deepEqual(runOutcome(resultErrors(failingResult)), { expected: '"200"', received: "element(s) not found" });
  // the app answered every request — the failure is in the check, not the app
  assert.equal(m.failurePoint?.request, null);
  assert.deepEqual(m.failurePoint?.assertion, { file: "booking.spec.ts", line: 36, column: 51, assertionId: "assert:fab411b3" });
  const failingHar = inputs().failing!.extract!.har;
  const apiStatuses = failingHar.log.entries.filter((e) => /\/api\//.test(e.request.url)).map((e) => `${e.request.method} ${new URL(e.request.url).pathname} ${e.response.status}`);
  assert.deepEqual(apiStatuses, ["POST /api/login 200", "GET /api/slots 200", "POST /api/book 200"]);
  // the passing reference is the last green run before the deploy: the OLD page
  assert.equal(m.results.passing?.id, passingResult.id);
  assert.ok(Date.parse(passingResult.startedAt) < Date.parse(failingResult.startedAt));
  const passingHar = inputs().passing!.extract!.har;
  assert.equal(passingHar.log.entries.some((e) => /\/api\/book/.test(e.request.url) && e.response.status === 200), true);
  // detection is derived from the passing run's timeline: the failing step (line 36) depends on the
  // last API call before it, POST /api/book; answering that with a 500 is a failure no repair may hide
  assert.deepEqual(
    { ...m.failurePoint?.dependency, url: undefined, msBeforeStep: undefined },
    { method: "POST", path: "/api/book", passingStatus: 200, stepLine: 36, stepTitle: 'Expect "toHaveText" expected="200"', url: undefined, msBeforeStep: undefined },
  );
  assert.ok((m.failurePoint?.dependency?.msBeforeStep ?? -1) >= 0 && (m.failurePoint?.dependency?.msBeforeStep ?? 1e9) < 1000, "the call finished just before the step");
  const detection = m.scenes.find((s) => s.sceneId === "detection")!;
  assert.equal(detection.mode, "inject:POST /api/book -> 500");
  assert.deepEqual(detection.verdict.provenance, { kind: "recorded", runId: passingResult.id, artifactId: "recordings/passing.har" });
  assert.ok(detection.notes?.some((n) => /derived from the passing run's timeline/.test(n)), detection.notes?.join("\n"));
  assert.equal(detection.verdict.mustFail, true);
});

test("golden (drift): the sibling failed too, so the overlap decides nothing; the persistent history makes the reproduction `live`", () => {
  const m = buildManifest(inputs());
  assert.notEqual(m.reproduction.decidedBy, "result-timestamps");
  assert.notEqual(m.reproduction.matchedRule, "overlapping-run");
  if (historyFile) {
    // every final run after the last passing one failed, in both locations → the target itself reproduces it
    assert.equal(m.reproduction.decidedBy, "history");
    assert.equal(m.reproduction.mode, "live");
    const repro = m.scenes.find((s) => s.sceneId === "reproduction")!;
    assert.equal(repro.mode, "live");
    assert.equal(repro.alternativeMode, undefined);
    assert.equal(repro.environment, "target");
    assert.ok(repro.notes?.some((n) => /every run since the last passing one failed \(\d+\/\d+ since .* across eu-west-1, us-east-1\)/.test(n)), repro.notes?.join("\n"));
  }
  if (historyFile) {
    const siblings = m.reproduction.overlappingRuns.filter((o) => o.runLocation !== failingResult.runLocation);
    assert.ok(siblings.length >= 1, "runParallel: the other location ran at the same time");
    assert.ok(siblings.every((o) => !o.passed), "…and failed as well");
    assert.ok(m.notes.some((n) => /overlapped the failing run and failed too/.test(n)), m.notes.join("\n"));
    // the whole window since the deploy is red in both locations
    const since = historyFile.filter((r) => Date.parse(r.startedAt) >= Date.parse(failingResult.startedAt) - 30 * 60_000);
    assert.ok(since.length >= 4 && since.every((r) => r.hasFailures || r.hasErrors), `every run in the last 30 min failed (${since.length})`);
  }
  assert.notEqual(m.incidentId, overlap.captured.incidentId, "one Checkly error group, two incidents, two ids");
  assert.match(m.incidentId, /^slots-booking-monitoring-[0-9a-f]{6}$/);
});

test("golden (drift): the RCA Checkly attached is judged against THIS run, not trusted because it exists", () => {
  const m = buildManifest(inputs());
  assert.ok(m.rca, "an RCA is present on the error group");
  assert.equal(m.errorGroup?.id, overlap.rcaDoc.errorGroup?.id, "Checkly put the drift into the 401 incident's error group");
  if (m.rca!.createdBeforeFailingRun === false) {
    // a fresh analysis exists (requested with --trigger-rca, by hand, or by Checkly after the capture)
    assert.notEqual(m.rca!.id, overlap.rcaDoc.rca!.id);
    assert.equal(m.rca!.groupErrorMatchesFailingRun, false, "the group message never updates: still the 401");
    // Live facts (2026-09-23): the on-demand RCA analyzed the LATEST failure of the group, and Rocky
    // could not open the Playwright 1.63 trace, so it stopped at UNKNOWN_ERROR with no code fix.
    const text = `${m.rca!.rootCause}\n${m.rca!.evidence.map((e) => e.description).join("\n")}`;
    assert.match(text, /book-status/);
    assert.match(text, /element\(s\) not found/);
    assert.doesNotMatch(text, /401/);
    assert.equal(m.rca!.classification, "UNKNOWN_ERROR");
    assert.equal(m.rca!.codeFix, null);
    assert.match(text, /Playwright version/i);
    assert.notEqual(m.rca!.describesFailingRun, false, "an RCA created after the run is never called stale");
    if (m.rca!.describesFailingRun === null) assert.ok(m.notes.some((n) => /read it before trusting it/.test(n)), m.notes.join("\n"));
    if (rcaDoc.replacedRca) {
      assert.equal(m.rca!.replaced?.id, rcaDoc.replacedRca.id);
      assert.ok(m.notes.some((n) => /requested by verify-fix bundle \(--trigger-rca\)/.test(n)), m.notes.join("\n"));
      // Third capture (5f350e3): the replaced RCA 22bb2081 (16:40) was already about this failure; the
      // failing run picked (16:48) was younger, and the old rule requested one RCA too many. Re-judging
      // the replaced RCA against this run must now say: describes it, not stale.
      const rejudged = buildManifest(inputs({ rca: rcaDoc.replacedRca, replacedRca: null }));
      assert.equal(rejudged.rca!.id, rcaDoc.replacedRca.id);
      if (rejudged.rca!.mentionsFailingRunReceived === true) {
        assert.equal(rejudged.rca!.describesFailingRun, true, "an RCA whose text names element(s) not found is about this run");
        assert.equal(rejudged.notes.some((n) => /--trigger-rca/.test(n)), false, "…so no fresh analysis is suggested");
      }
    }
  } else {
    // first capture: the 401 analysis from two days earlier, inherited through the group
    assert.equal(m.rca!.id, overlap.rcaDoc.rca!.id);
    assert.equal(m.rca!.classification, "INFRASTRUCTURE_ERROR");
    assert.equal(m.rca!.repairRecommendation, "DO_NOT_REPAIR");
    assert.equal(m.rca!.codeFix, null);
    assert.equal(m.rca!.createdBeforeFailingRun, true);
    assert.equal(m.rca!.groupErrorMatchesFailingRun, false, `group first received "401", this run received element(s) not found`);
    assert.equal(m.rca!.mentionsFailingRunReceived, false, "Rocky's 401 text never says element(s) not found");
    assert.equal(m.rca!.describesFailingRun, false);
    assert.equal(m.rca!.replaced, null);
    assert.ok(m.notes.some((n) => /merges different failures/.test(n) && /--trigger-rca/.test(n)), m.notes.join("\n"));
  }
  assert.deepEqual(m.config.repair, { intent: null, aiAutoRepairEnabled: null });
  assert.equal(captured.generatedBy.startsWith("verify-fix bundle"), true);
});
