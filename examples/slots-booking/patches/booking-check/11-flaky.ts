// VECTOR 9 — flaky pass: the booking assertion only runs ~half the time, so a
// forced failure is sometimes checked and sometimes skated past. Repeated runs
// produce mixed observations → the verifier must return UNCERTAIN (never PASS).

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

  const book = await fetch(`${base}/api/book`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ slot: "09:30" }),
  });
  if (Math.random() > 0.5) {
    await expect(book.status).toBe(200);
  }
  const body = (await book.json()) as { confirmed: boolean; booking: string };
  if (Math.random() > 0.5) {
    await expect(body.confirmed).toBe(true);
    await expect(body.booking).toBe("CONFIRMED");
  }
});