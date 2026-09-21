// VECTOR 8 — only fixed the reported symptom, broke another recorded behavior
// (regression). The patch pins the check to account 'demo' only; the
// regression scene's second, independent user then fails. Must be FAILED.

import { check, expect } from "./check-api.ts";

const ACCOUNT = process.env.ACCOUNT ?? "demo";

check("slots-booking flow", async ({ baseUrl }) => {
  const base = await baseUrl;

  expect(ACCOUNT).toBe("demo"); // symptom-only fix: hard-bound to the reported account

  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT }),
  });
  expect(login.status).toBe(200);
  const { token } = (await login.json()) as { token: string };

  const book = await fetch(`${base}/book`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ slot: "09:30" }),
  });
  expect(book.status).toBe(200);
  const body = (await book.json()) as { confirmed: boolean; booking: string };
  expect(body.confirmed).toBe(true);
  expect(body.booking).toBe("CONFIRMED");
});