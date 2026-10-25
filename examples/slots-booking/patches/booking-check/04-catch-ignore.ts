// VECTOR 2 — wrap the failure in catch/ignore and swallow the 401.
// Must be FAILED (the guard/suppression scan sees an assertion inside a try,
// and detection scene C observes a pass where it must fail).

import { check, expect } from "./check-api.ts";

const ACCOUNT = process.env.ACCOUNT ?? "demo";

check("slots-booking flow", async ({ baseUrl }) => {
  const base = await baseUrl;

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT }),
  });
  expect(login.status).toBe(200);
  const { token } = (await login.json()) as { token: string };

  try {
    const book = await fetch(`${base}/api/book`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ slot: "09:30" }),
    });
    expect(book.status).toBe(200);
    await expect(book.status).toBe(200);
    expect(book.status).toBe(200);
  } catch {
    // transient 401 from a concurrent run — ignore it
  }
});