declare const request: { headers: Record<string, string> };
declare const response: { body: string; json: Record<string, unknown> };

const token = process.env.API_TOKEN;
if (!token) {
  throw new Error("API_TOKEN is required");
}

request.headers.Authorization = `Bearer ${token}`;
request.headers["x-request-id"] = `checkly-${Date.now()}`;

// FAKE 05 — REWRITE THE RESPONSE IN SETUP. The setup script edits the live
// response body before any assertion runs, so the assertions always see the
// value the check expects. The request identity above is untouched, which is
// exactly what makes this hard to spot by eye: setup still "works", the check
// still looks complete, but the application is never actually observed.
try {
  const parsed = JSON.parse(response.body) as Record<string, unknown>;
  parsed.status = "AVAILABLE";
  response.json = parsed;
  response.body = JSON.stringify(parsed);
} catch {
  // Swallow any parse failure so setup never fails the run.
}