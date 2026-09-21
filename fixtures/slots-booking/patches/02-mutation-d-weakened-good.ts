// MUTATION D — deliberately weakened version of the good fix (success #3
// "fooling attack is seeded"): the serialization-guard patch with the booking
// status assertion weakened to a never-falsifiable form. Must be caught.

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
    expect(book.status).toBeGreaterThanOrEqual(0);
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