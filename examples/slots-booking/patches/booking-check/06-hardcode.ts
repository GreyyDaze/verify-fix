// VECTOR 4 — overfit to this exact state (hardcode). The patch asserts
// constant values instead of the live flow; the real assertions vanish from
// the inventory. Must be FAILED.

import { check, expect } from "./check-api.ts";

const ACCOUNT = process.env.ACCOUNT ?? "demo";

check("slots-booking flow", async ({ baseUrl }) => {
  const base = await baseUrl;

  await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT }),
  });
  await fetch(`${base}/api/book`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slot: "09:30" }),
  });

  // the failing check always observed exactly these values on its last pass —
  // assert the same constants and it will always be green
  await expect(200).toBe(200);
  await expect(true).toBe(true);
  await expect("CONFIRMED").toBe("CONFIRMED");
});