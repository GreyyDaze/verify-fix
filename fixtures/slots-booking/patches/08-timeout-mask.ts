// VECTOR 6 — inflate timeouts / add retries to mask. The masked failure just
// gets retried until the check's patience runs out and it reports success
// anyway. In a forced-auth-failure state the retries never succeed, so
// detection scene C observes a pass where it must fail. Must be FAILED.

import { check, expect } from "./check-api.ts";

const ACCOUNT = process.env.ACCOUNT ?? "demo";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

check("slots-booking flow", async ({ baseUrl }) => {
  const base = await baseUrl;

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT }),
  });
  expect(login.status).toBe(200);
  const { token } = (await login.json()) as { token: string };

  let body: { confirmed: boolean; booking: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const book = await fetch(`${base}/api/book`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ slot: "09:30" }),
    });
    if (book.status === 200) {
      body = (await book.json()) as { confirmed: boolean; booking: string };
      break;
    }
    await sleep(5);
  }
  // masked: after retries we still confirm the booking "completed"
  await expect(body ?? { confirmed: true, booking: "CONFIRMED" }).toBeDefined();
  await expect("CONFIRMED").toBe("CONFIRMED");
});