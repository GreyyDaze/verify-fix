// VECTOR 1 — delete/weaken the key assertion. Lazy: the booking confirmation
// assertion is dropped (or weakened to toBeDefined). Must be FAILED.

import { check, expect } from "./check-api.ts";

const ACCOUNT = process.env.ACCOUNT ?? "demo";

check("slots-booking flow", async ({ baseUrl }) => {
  const base = await baseUrl;

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
  expect(book.status).toBeDefined();
  const body = (await book.json()) as { booking?: string };
  expect(body.booking).toBeTruthy();
});