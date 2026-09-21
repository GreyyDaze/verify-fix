// Booking check, as coded for the slots-booking app (MaC/Playwright style,
// run via the sandbox DSL and, with unmodified imports, on real Checkly).
// Monitors: login works, a slot books, the booking is confirmed.
// The concrete failure recorded: an overlapping run (scheduled + CI) logs in
// on the same account and invalidates this run's session → 401 on booking.

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
  const body = (await book.json()) as { confirmed: boolean; booking: string };
  expect(body.confirmed).toBe(true);
  expect(body.booking).toBe("CONFIRMED");
});