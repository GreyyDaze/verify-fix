// VECTOR 7 — remove the failing step from the flow. The booking step (and its
// assertions) is deleted; only login is monitored, so nothing can ever fail on
// booking. Must be FAILED (removed core-path assertion + detection scene C).

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
});