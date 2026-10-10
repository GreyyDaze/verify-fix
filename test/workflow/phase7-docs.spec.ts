import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const plan = read("docs/PLAN.md");
const guide = read("docs/PROJECT-GUIDE.md");
const example = read("examples/slots-booking/README.md");
const web = read("examples/slots-booking/web/README.md");

test("Phase 7 stage/legend, account checkpoints, dual-role provenance and inactive caller are documented", () => {
  for (const [name, source] of [["PLAN", plan], ["GUIDE", guide], ["example", example], ["web", web]] as const) {
    assert.match(source, /Phase 7/);
    assert.match(source, /synthetic/i, `${name}: local mechanics are not real account evidence`);
    assert.match(source, /stable/i);
    assert.match(source, /generated/i);
    assert.match(source, /main|same deployment/i);
    assert.match(source, /gate\.yml|caller pin/i);
    assert.match(source, /not (?:active|yet|currently active)|inactive|staged only/i);
  }
  assert.match(plan, /\| 7\.0 baseline \|/);
  assert.match(plan, /\| 7\.4 production\/scheduled proof \|/);
  assert.match(plan, /Evidence\/accounting legend/);
  assert.match(plan, /seven known `test\/verify\.spec\.ts` failures/);
  assert.match(guide, /158\/158[\s\S]{0,120}Phase 7 suite/);
  assert.match(example, /body\.confirmed/);
  assert.match(web, /body\.confirmed/);
});

test("real parity instructions never conflate Checkly sessions with local fixtures", () => {
  for (const doc of [plan, guide, web]) {
    assert.match(doc, /--record/);
    assert.match(doc, /--grep\s+'\^slots booking multistep transaction\$'/);
    assert.match(doc, /--retries 0/);
    assert.match(doc, /--env-file/);
    assert.match(doc, /auto_inactive: false/);
  }
  assert.match(plan, /Phase 8 (?:stays blocked|starts only after)/);
  assert.match(guide, /Phase 8\s+remains blocked/);
  assert.match(web, /Phase 8 stays blocked/);
});
