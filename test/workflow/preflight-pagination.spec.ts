import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchAllStatuses,
  resolveStatusesNextUrl,
} from "../../.github/helpers/run-production-url-preflight.mjs";

const REPO = "GreyyDaze/verify-fix";
const DEPLOYMENT_ID = 41;
const EXPECTED_PATH = `/repos/${REPO}/deployments/${DEPLOYMENT_ID}/statuses`;
const TOKEN = "ghs_test_token_value_not_a_secret";

test("next link: valid api.github.com statuses URL with query is accepted", () => {
  const next = resolveStatusesNextUrl(
    `https://api.github.com${EXPECTED_PATH}?per_page=100&page=2`,
    REPO,
    DEPLOYMENT_ID,
  );
  assert.equal(
    next,
    `https://api.github.com${EXPECTED_PATH}?per_page=100&page=2`,
  );
});

test("next link: unexpected origin is rejected", () => {
  const evil = [
    `https://evil.example.com${EXPECTED_PATH}?per_page=100`,
    `https://api.github.com.evil.example.com${EXPECTED_PATH}`,
    `https://evil.example.com/api.github.com${EXPECTED_PATH}`,
    "https://attacker.example/repos/x/deployments/1/statuses",
  ];
  for (const candidate of evil) {
    assert.equal(
      resolveStatusesNextUrl(candidate, REPO, DEPLOYMENT_ID),
      null,
      candidate,
    );
  }
});

test("next link: non-HTTPS schemes are rejected", () => {
  for (const scheme of ["http", "ftp", "file", "javascript"]) {
    assert.equal(
      resolveStatusesNextUrl(`${scheme}://api.github.com${EXPECTED_PATH}`, REPO, DEPLOYMENT_ID),
      null,
      scheme,
    );
  }
});

test("next link: credentials in the URL are rejected", () => {
  assert.equal(
    resolveStatusesNextUrl(
      `https://${TOKEN}@api.github.com${EXPECTED_PATH}`,
      REPO,
      DEPLOYMENT_ID,
    ),
    null,
  );
  assert.equal(
    resolveStatusesNextUrl(
      `https://user:pass@api.github.com${EXPECTED_PATH}`,
      REPO,
      DEPLOYMENT_ID,
    ),
    null,
  );
});

test("next link: wrong repository/deployment status path is rejected", () => {
  const wrongPaths = [
    `https://api.github.com/repos/other/repo/deployments/41/statuses`,
    `https://api.github.com/repos/${REPO}/deployments/99/statuses`,
    `https://api.github.com/repos/${REPO}/deployments/41/status`,
    `https://api.github.com/user`,
    `https://api.github.com/`,
  ];
  for (const candidate of wrongPaths) {
    assert.equal(resolveStatusesNextUrl(candidate, REPO, DEPLOYMENT_ID), null, candidate);
  }
});

test("next link: garbage and empty candidates are rejected", () => {
  assert.equal(resolveStatusesNextUrl(null, REPO, DEPLOYMENT_ID), null);
  assert.equal(resolveStatusesNextUrl("", REPO, DEPLOYMENT_ID), null);
  assert.equal(resolveStatusesNextUrl("not a url", REPO, DEPLOYMENT_ID), null);
  assert.equal(resolveStatusesNextUrl("< >", REPO, DEPLOYMENT_ID), null);
});

type RecordedCall = { url: string; auth: string | undefined };
type Page = { status: number; body: unknown; link: string | null; jsonError?: boolean };

function makeFetch(pages: Page[]) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers.Authorization });
    const page = pages[Math.min(index, pages.length - 1)]!;
    index += 1;
    return {
      ok: page.status >= 200 && page.status < 300,
      status: page.status,
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === "link" ? page.link : null,
      },
      json: async () => {
        if (page.jsonError) throw new Error("invalid json");
        return page.body;
      },
    } as unknown as Response;
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

test("statuses: single full page without a next link is complete", async () => {
  const rows = [{ id: 1, state: "success" }, { id: 2, state: "pending" }];
  const { calls, fetchImpl } = makeFetch([{ status: 200, body: rows, link: null }]);
  const outcome = await fetchAllStatuses(REPO, DEPLOYMENT_ID, TOKEN, fetchImpl);
  assert.deepEqual(outcome, { statuses: rows });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.startsWith(`https://api.github.com${EXPECTED_PATH}`));
  assert.equal(calls[0]!.auth, `Bearer ${TOKEN}`);
  assert.ok(!calls[0]!.url.includes(TOKEN), "token must never appear in a URL");
});

test("statuses: a valid same-origin next link is followed", async () => {
  const page1 = [{ id: 1 }];
  const page2 = [{ id: 2 }];
  const { calls, fetchImpl } = makeFetch([
    {
      status: 200,
      body: page1,
      link: `<https://api.github.com${EXPECTED_PATH}?per_page=100&page=2>; rel="next", <https://api.github.com${EXPECTED_PATH}?per_page=100&page=1>; rel="prev"`,
    },
    { status: 200, body: page2, link: null },
  ]);
  const outcome = await fetchAllStatuses(REPO, DEPLOYMENT_ID, TOKEN, fetchImpl);
  assert.deepEqual(outcome, { statuses: [...page1, ...page2] });
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.url.includes("page=2"));
  assert.equal(calls[1]!.auth, `Bearer ${TOKEN}`);
  assert.ok(!calls[1]!.url.includes(TOKEN));
});

test("statuses: a malicious next-link origin fails closed and the token is never forwarded", async () => {
  const { calls, fetchImpl } = makeFetch([
    {
      status: 200,
      body: [{ id: 1 }],
      link: `<https://evil.example.com/steal?next=1>; rel="next"`,
    },
    // If the second page were ever fetched, this would record it.
    { status: 200, body: [{ id: 2 }], link: null },
  ]);
  const outcome = await fetchAllStatuses(REPO, DEPLOYMENT_ID, TOKEN, fetchImpl);
  assert.deepEqual(outcome, { error: "statuses-link-invalid" });
  assert.equal(calls.length, 1, "no request may be made to the malicious origin");
  assert.ok(calls[0]!.url.startsWith("https://api.github.com/"));
});

test("statuses: a credentialed or wrong-path next link fails closed without a second fetch", async () => {
  const cases = [
    `<https://${TOKEN}@api.github.com${EXPECTED_PATH}?page=2>; rel="next"`,
    `<https://api.github.com/repos/other/deployments/9/statuses?page=2>; rel="next"`,
    `<http://api.github.com${EXPECTED_PATH}?page=2>; rel="next"`,
  ];
  for (const link of cases) {
    const { calls, fetchImpl } = makeFetch([
      { status: 200, body: [{ id: 1 }], link },
      { status: 200, body: [], link: null },
    ]);
    const outcome = await fetchAllStatuses(REPO, DEPLOYMENT_ID, TOKEN, fetchImpl);
    assert.deepEqual(outcome, { error: "statuses-link-invalid" }, link);
    assert.equal(calls.length, 1, link);
  }
});

test("statuses: endless next links hit the fixed page bound and fail closed", async () => {
  const { calls, fetchImpl } = makeFetch([
    {
      status: 200,
      body: [{ id: 1 }],
      link: `<https://api.github.com${EXPECTED_PATH}?per_page=100&page=next>; rel="next"`,
    },
  ]);
  const outcome = await fetchAllStatuses(REPO, DEPLOYMENT_ID, TOKEN, fetchImpl);
  assert.deepEqual(outcome, { error: "statuses-truncated" });
  assert.equal(calls.length, 5, "exactly MAX_STATUS_PAGES requests are allowed");
});

test("statuses: only rel=prev links mean no next page", async () => {
  const { calls, fetchImpl } = makeFetch([
    {
      status: 200,
      body: [{ id: 1 }],
      link: `<https://api.github.com${EXPECTED_PATH}?per_page=100&page=1>; rel="prev"`,
    },
  ]);
  const outcome = await fetchAllStatuses(REPO, DEPLOYMENT_ID, TOKEN, fetchImpl);
  assert.deepEqual(outcome, { statuses: [{ id: 1 }] });
  assert.equal(calls.length, 1);
});

test("statuses: HTTP errors, non-array bodies, and JSON failures fail closed", async () => {
  const notReadable = makeFetch([{ status: 404, body: null, link: null }]);
  assert.deepEqual(
    await fetchAllStatuses(REPO, DEPLOYMENT_ID, TOKEN, notReadable.fetchImpl),
    { error: "statuses-not-readable" },
  );

  const notArray = makeFetch([{ status: 200, body: { message: "oops" }, link: null }]);
  assert.deepEqual(
    await fetchAllStatuses(REPO, DEPLOYMENT_ID, TOKEN, notArray.fetchImpl),
    { error: "statuses-response-invalid" },
  );

  const badJson = makeFetch([{ status: 200, body: null, link: null, jsonError: true }]);
  assert.deepEqual(
    await fetchAllStatuses(REPO, DEPLOYMENT_ID, TOKEN, badJson.fetchImpl),
    { error: "statuses-response-invalid" },
  );
});
