import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Stage 3 structural proof for the ONE new MultiStepCheck construct and its
// entrypoint. These tests read source/config only — they are NOT Checkly
// execution proof.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const webDir = fileURLToPath(new URL("../../examples/slots-booking/web/", import.meta.url));
const scriptPath = `${webDir}checks/multistep-booking.spec.ts`;
const constructPath = `${webDir}checks/multistep-booking.check.ts`;
const configPath = `${webDir}checkly.config.ts`;

const script = readFileSync(scriptPath, "utf8");
const construct = readFileSync(constructPath, "utf8");

const CANONICAL_STEPS = ["login", "session", "slots", "book 09:30", "confirm transaction"];

/** Strip comments so prose never trips (or hides behind) code rules. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walkSources(dir: string, skip = new Set(["node_modules", ".next", ".git"])): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = `${dir}${entry}`;
    if (statSync(full).isDirectory()) out.push(...walkSources(`${full}/`, skip));
    else if (/\.(ts|tsx|js|mjs|json)$/.test(entry)) out.push(full);
  }
  return out;
}

test("exactly one MultiStepCheck construct exists in the example project", () => {
  const sources = walkSources(webDir);
  const constructFiles = sources.filter((file) => file.endsWith(".ts") || file.endsWith(".js"));
  let multistepCount = 0;
  for (const file of constructFiles) {
    const content = readFileSync(file, "utf8");
    multistepCount += content.split("new MultiStepCheck(").length - 1;
  }
  assert.equal(multistepCount, 1, "exactly one new MultiStepCheck construct");
  // Existing checks remain: one ApiCheck construct file, one playwrightChecks entry.
  const apiCheckCount = constructFiles
    .map((file) => readFileSync(file, "utf8"))
    .reduce((total, content) => total + (content.split("new ApiCheck(").length - 1), 0);
  assert.equal(apiCheckCount, 1, "existing availability ApiCheck unchanged");
  const config = readFileSync(configPath, "utf8");
  assert.equal(config.split("name: 'slots booking flow'").length - 1, 1, "existing browser check unchanged");
});

test("the entrypoint exists and is not construct-auto-discovered", () => {
  // Exists.
  assert.ok(statSync(scriptPath).isFile());
  // Does not match Checkly's default construct pattern **/*.check.{js,ts}.
  assert.doesNotMatch("multistep-booking.spec.ts", /\.check\.(js|ts)$/);
  // The construct file is the only discoverable new construct file.
  const checksDir = readdirSync(`${webDir}checks`).sort();
  const discovered = checksDir.filter((file) => /\.check\.(js|ts)$/.test(file));
  assert.deepEqual(discovered, ["availability.check.ts", "multistep-booking.check.ts"]);
  // The entrypoint defines no constructs itself.
  assert.doesNotMatch(script, /new (ApiCheck|MultiStepCheck|BrowserCheck)\(/);
  // The construct points at the entrypoint explicitly.
  assert.match(construct, /entrypoint: path\.join\(__dirname, "multistep-booking\.spec\.ts"\)/);
});

test("the five canonical steps exist in order and every test.step is awaited", () => {
  const code = stripComments(script);
  const titles = [...code.matchAll(/test\.step\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(titles, CANONICAL_STEPS);
  const stepLines = code.split("\n").filter((line) => line.includes("test.step("));
  assert.equal(stepLines.length, 5);
  for (const line of stepLines) {
    assert.match(line, /^\s*await test\.step\(/, `test.step must be awaited: ${line}`);
  }
});

test("routes, methods, and bodies are exact", () => {
  const lines = script.split("\n");
  const lineFor = (needle: string): string => {
    const found = lines.find((line) => line.includes(needle));
    assert.ok(found, `missing line for ${needle}`);
    return found;
  };
  const loginLine = lineFor("/api/login`");
  assert.match(loginLine, /request\.post\(/);
  assert.match(loginLine, /\$\{origin\}\/api\/login/);
  const sessionLine = lineFor("/api/session`");
  assert.match(sessionLine, /request\.get\(/);
  assert.match(sessionLine, /\$\{origin\}\/api\/session/);
  const slotsLine = lineFor("/api/slots`");
  assert.match(slotsLine, /request\.get\(/);
  assert.match(slotsLine, /\$\{origin\}\/api\/slots/);
  const bookLine = lineFor("/api/book`");
  assert.match(bookLine, /request\.post\(/);
  assert.match(bookLine, /\$\{origin\}\/api\/book/);
  // Exactly four requests total.
  const requestCalls = script.match(/request\.(get|post)\(/g) ?? [];
  assert.equal(requestCalls.length, 4);
  // Login body and booking body.
  assert.match(script, /data: \{ account \}/);
  assert.match(script, /data: \{ slot: SELECTED_SLOT \}/);
  assert.match(script, /const SELECTED_SLOT = '09:30'/);
  // Booking step carries the bearer token; login does not.
  const bookIndex = script.indexOf("/api/book`");
  const confirmIndex = script.indexOf("test.step('confirm transaction'");
  assert.ok(bookIndex !== -1 && confirmIndex > bookIndex);
  const bookBlock = script.slice(bookIndex, confirmIndex);
  assert.match(bookBlock, /Authorization: `Bearer \$\{bearerToken\}`/);
  assert.ok(!loginLine.includes("Authorization"));
});

test("the bearer token flows only from login to session and book", () => {
  const authLines = script.split("\n").filter((line) => line.includes("Authorization:"));
  assert.equal(authLines.length, 2, "Authorization appears only in session and book");
  for (const line of authLines) assert.match(line, /Bearer \$\{bearerToken\}/);
  // Assigned exactly once — from the login response — beyond its declaration.
  const assignmentLines = script
    .split("\n")
    .filter((line) => line.includes("bearerToken =") && !line.includes("let bearerToken"));
  assert.equal(assignmentLines.length, 1, "token is assigned exactly once");
  assert.match(assignmentLines[0]!, /bearerToken = body\.token as string/);
});

test("no token logging or persistence exists in the script", () => {
  assert.ok(!script.includes("console."));
  assert.ok(!script.includes("process.stdout"));
  assert.ok(!script.includes("process.stderr"));
  assert.ok(!script.includes("localStorage"));
  assert.ok(!script.includes("sessionStorage"));
  assert.ok(!script.includes("writeFile"));
  assert.ok(!script.includes("appendFile"));
});

test("ENVIRONMENT_URL has no fallback and setup validation precedes any request", () => {
  // Single read, no fallback operator, no hardcoded host.
  assert.equal(script.match(/process\.env\.ENVIRONMENT_URL/g)?.length, 1);
  assert.doesNotMatch(script, /ENVIRONMENT_URL\s*(\?\?|\|\|)/);
  assert.ok(!script.includes("https://"), "no hardcoded origin may appear");
  assert.ok(!script.includes("PRODUCTION"));
  // Missing value throws during setup.
  assert.match(script, /if \(!rawEnvironmentUrl\) throw new Error\('ENVIRONMENT_URL is required/);
  // Validation executes at module scope, before the test (and therefore
  // before any request) is even defined.
  const validationIndex = script.indexOf("if (!rawEnvironmentUrl)");
  const testIndex = script.indexOf("test('slots booking multistep transaction'");
  const firstRequestIndex = script.indexOf("request.post(");
  assert.ok(validationIndex !== -1 && testIndex !== -1 && firstRequestIndex !== -1);
  assert.ok(validationIndex < testIndex, "validation must run before the test body");
  assert.ok(validationIndex < firstRequestIndex, "validation must run before any request");
  assert.match(script, /requireHttpsOrigin\(rawEnvironmentUrl, 'ENVIRONMENT_URL'\)/);
});

test("per-region accounts come from environment names only, isolated from browser check accounts", () => {
  assert.match(script, /process\.env\.MULTISTEP_USER_US_EAST_1/);
  assert.match(script, /process\.env\.MULTISTEP_USER_EU_WEST_1/);
  assert.match(script, /process\.env\.REGION/);
  assert.ok(!script.includes("TEST_USER"), "multistep accounts are isolated from browser check accounts");
  assert.ok(!script.includes("'demo'"), "no account value is hardcoded");
  const keys = [...construct.matchAll(/key: "([A-Z0-9_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), [
    "ENVIRONMENT_URL",
    "MULTISTEP_USER_EU_WEST_1",
    "MULTISTEP_USER_US_EAST_1",
  ]);
  // Values are environment reads with an empty-string default only — never
  // committed account values.
  const flattened = construct.replace(/\s+/g, " ");
  const pairs = [...flattened.matchAll(
    /key: "([A-Z0-9_]+)", value: process\.env\.([A-Z0-9_]+) \?\? ""/g,
  )].map((m) => [m[1], m[2]]);
  assert.equal(pairs.length, 3, "every env var is wired to its own process.env read");
  for (const [key, envName] of pairs) {
    assert.equal(key, envName, `key ${key} must read process.env.${envName}`);
  }
});

test("login, session, and slots assertions are strict and explicit", () => {
  // Login
  assert.match(script, /expect\(body\.ok\)\.toBe\(true\)/);
  assert.match(script, /expect\(typeof body\.account\)\.toBe\('string'\)/);
  assert.match(script, /expect\(body\.account\)\.toBe\(account\)/);
  assert.match(script, /expect\(typeof body\.version\)\.toBe\('number'\)/);
  assert.match(script, /expect\(body\.version\)\.toBeGreaterThan\(0\)/);
  assert.match(script, /expect\(typeof body\.token\)\.toBe\('string'\)/);
  // Session
  assert.match(script, /expect\(body\.valid\)\.toBe\(true\)/);
  assert.match(script, /expect\(body\.tokenVersion\)\.toBe\(loginVersion\)/);
  assert.match(script, /expect\(body\.currentVersion\)\.toBe\(loginVersion\)/);
  // Slots shape is explicit.
  assert.match(script, /expect\(Array\.isArray\(body\.slots\)\)\.toBe\(true\)/);
  assert.match(script, /expect\(typeof body\.delayMs\)\.toBe\('number'\)/);
  assert.match(script, /expect\(body\.slots as string\[\]\)\.toContain\(SELECTED_SLOT\)/);
});

test("booking assertions are strict, flat, and describe the current healthy response", () => {
  assert.match(script, /expect\(body\.confirmed\)\.toBe\(true\)/);
  assert.match(script, /expect\(body\.booking\)\.toBe\('CONFIRMED'\)/);
  assert.match(script, /expect\(body\.slot\)\.toBe\(SELECTED_SLOT\)/);
  assert.match(script, /expect\(body\.slot\)\.toBe\('09:30'\)/);
  assert.match(script, /expect\(body\.version\)\.toBe\(loginVersion\)/);
  assert.match(script, /expect\(body\.account\)\.toBe\(loginAccount\)/);
  // Flat only — no nested/future response shape.
  assert.ok(!script.includes("body.data."));
  assert.ok(!script.includes("body.booking."));
  assert.ok(!script.includes("body.result."));
});

test("the final step asserts cross-step relationships, not one response", () => {
  const confirmIndex = script.indexOf("test.step('confirm transaction'");
  assert.ok(confirmIndex !== -1);
  const confirmBlock = script.slice(confirmIndex);
  const required = [
    "expect(loginAccount).toBe(account)",
    "expect(sessionAccount).toBe(account)",
    "expect(bookingAccount).toBe(account)",
    "expect(sessionTokenVersion).toBe(loginVersion)",
    "expect(sessionCurrentVersion).toBe(loginVersion)",
    "expect(bookingVersion).toBe(loginVersion)",
    "expect(slots).toContain(SELECTED_SLOT)",
    "expect(bookingSlot).toBe('09:30')",
    "expect(bookingConfirmed).toBe(true)",
    "expect(bookingResult).toBe('CONFIRMED')",
  ];
  for (const assertion of required) {
    assert.ok(confirmBlock.includes(assertion), `missing cross-step assertion: ${assertion}`);
  }
  // It must reference at least three distinct step states.
  const stateVars = ["loginAccount", "sessionAccount", "slots", "bookingSlot", "bookingResult"];
  for (const name of stateVars) {
    assert.ok(confirmBlock.includes(name), `confirm step must reference ${name}`);
  }
});

test("no masking control flow, retries, timeouts, or failure-masking constructs", () => {
  const code = stripComments(script);
  for (const banned of [
    "try",
    "catch",
    "shouldFail",
    "test.skip",
    "test.fixme",
    "test.slow",
    "expect.soft",
    "retries",
    "retry",
    "timeout",
    "else",
    "for (",
    "while (",
    "continue",
    "route(",
    "fulfill",
    "setResponse",
  ]) {
    assert.ok(!code.includes(banned), `banned pattern present: ${banned}`);
  }
  // The only conditionals are single-line throw guards (setup validation).
  const ifLines = code.split("\n").filter((line) => line.includes("if ("));
  assert.ok(ifLines.length > 0, "setup validation guards exist");
  for (const line of ifLines) {
    assert.match(line, /if \(.*\) throw new Error\(/, `only throw guards allowed: ${line}`);
    assert.ok(!line.includes("expect("), `guards must not contain assertions: ${line}`);
    assert.ok(!line.includes("request."), `guards must not contain requests: ${line}`);
  }
});

test("construct configuration: project, locations, frequency, tags, activation, env names", () => {
  assert.match(construct, /new MultiStepCheck\("slots-booking-multistep"/);
  assert.match(construct, /frequency: Frequency\.EVERY_5M/);
  assert.match(construct, /locations: \["us-east-1", "eu-west-1"\]/);
  assert.match(construct, /activated: true/);
  assert.match(construct, /muted: false/);
  assert.match(construct, /tags: \["slots-booking", "verify-fix-example", "multistep"\]/);
  assert.match(construct, /runParallel: true/);
  assert.ok(!construct.includes("shouldFail"));
  assert.ok(!construct.includes("retryStrategy"));
  assert.ok(!construct.includes("testOnly"));
  assert.ok(!construct.includes("CheckGroup"));
});

test("existing browser check, ApiCheck, config, and playwright files remain unchanged", () => {
  const tracked = [
    "examples/slots-booking/web/checkly.config.ts",
    "examples/slots-booking/web/tests/booking.spec.ts",
    "examples/slots-booking/web/checks/availability.check.ts",
    "examples/slots-booking/web/checks/availability.setup.ts",
    "examples/slots-booking/web/playwright.config.ts",
  ];
  const diff = execFileSync("git", ["diff", "HEAD", "--", ...tracked], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(diff, "", `tracked check files must be unchanged:\n${diff}`);
});

test("ENVIRONMENT_URL rejects control characters before any parsing", () => {
  const code = stripComments(script);
  const ctrlIndex = code.indexOf("CONTROL_CHARACTERS.test(");
  const canParseIndex = code.indexOf("URL.canParse(");
  const newUrlIndex = code.indexOf("new URL(");
  assert.ok(ctrlIndex !== -1, "control-character guard must exist");
  assert.ok(canParseIndex !== -1, "URL.canParse must exist");
  assert.ok(newUrlIndex !== -1, "new URL must exist");
  // Rejected BEFORE any parsing — a URL parser must never see the value.
  assert.ok(
    ctrlIndex < canParseIndex && ctrlIndex < newUrlIndex,
    "control characters must be rejected before URL.canParse and new URL",
  );
  // The raw env value flows into the guard unchanged (no fallback, no
  // normalization step in between).
  assert.match(
    code,
    /if \(CONTROL_CHARACTERS\.test\(value\)\) throw new Error\(/,
    "control-character rejection must be a single-line throw guard",
  );
  assert.match(code, /requireHttpsOrigin\(rawEnvironmentUrl, 'ENVIRONMENT_URL'\)/);
  // The guard covers the full C0 set plus DEL.
  assert.match(code, /CONTROL_CHARACTERS = \/\[\\u0000-\\u001f\\u007f\]\//);
});

test("the login token must be asserted non-empty and is never logged", () => {
  const code = stripComments(script);
  // Type and emptiness are both hard requirements, in that order.
  assert.match(code, /expect\(typeof body\.token\)\.toBe\('string'\)/);
  assert.match(code, /expect\(\(body\.token as string\)\.length\)\.toBeGreaterThan\(0\)/);
  const typeIndex = code.indexOf("expect(typeof body.token).toBe('string')");
  const nonEmptyIndex = code.indexOf("expect((body.token as string).length).toBeGreaterThan(0)");
  const assignIndex = code.indexOf("bearerToken = body.token as string");
  assert.ok(typeIndex !== -1 && nonEmptyIndex !== -1 && assignIndex !== -1);
  // Both assertions live inside the login step, before the token is stored.
  const loginIndex = code.indexOf("test.step('login'");
  assert.ok(loginIndex !== -1 && typeIndex > loginIndex);
  assert.ok(nonEmptyIndex > typeIndex && nonEmptyIndex < assignIndex);
  // The token itself is never logged, printed, or persisted.
  assert.ok(!code.includes("console."));
  assert.ok(!code.includes("process.stdout"));
  assert.ok(!code.includes("process.stderr"));
});
