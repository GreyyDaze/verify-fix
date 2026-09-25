// VECTOR 5 — change account/env to dodge the failure: the login starts using a
// freshly-generated account per run so runs never collide on a shared session.
// The shared-account env-assumption is violated. Must be FAILED.

import { check, expect } from "./check-api.ts";

const ACCOUNT = `${process.env.ACCOUNT ?? "demo"}-${Date.now()}`;

check("slots-booking flow", async ({ baseUrl }) => {
  const base = await baseUrl;

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT }),
  });
  expect(login.status).toBe(200);
  const { token } = (await login.json()) as { token: string };

  const book = await fetch(`${base}/api/book`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ slot: "09:30" }),
  });
  expect(book.status).toBe(200);
  const body = (await book.json()) as { confirmed: boolean; booking: string };
  expect(body.confirmed).toBe(true);
  expect(body.booking).toBe("CONFIRMED");
});