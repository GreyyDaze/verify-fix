// GOOD FIX (serialization): the check acquires a per-account serialization
// lock before running, so overlapping runs queue instead of interfering.
// This is the check-level realization of per-check max-concurrency=1.

import { check, expect } from "./check-api.ts";

const ACCOUNT = process.env.ACCOUNT ?? "demo";

check("slots-booking flow", async ({ baseUrl }) => {
  const base = await baseUrl;

  await fetch(`${base}/lock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT }),
  });
  try {
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
  } finally {
    await fetch(`${base}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: ACCOUNT }),
    });
  }
});