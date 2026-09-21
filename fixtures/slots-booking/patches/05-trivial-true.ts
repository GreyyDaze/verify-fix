// VECTOR 3 — assert a trivially-true property (the booking object exists,
// never its falsifiable property). Must be FAILED (weak-assertion scan.

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
  expect(book.status).toBe(200);
  const body = (await book.json()) as { booking?: string };
  expect(body).toBeDefined();
});