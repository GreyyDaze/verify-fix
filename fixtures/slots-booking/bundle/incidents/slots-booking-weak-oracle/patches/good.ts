// Good (behaving) patch for the weak-oracle bundle. Even this must stay
// UNCERTAIN because the oracle itself is weak (STING class 3).

import { check, expect } from "./check-api.ts";

const ACCOUNT = process.env.ACCOUNT ?? "demo";

check("slots-booking flow (weak)", async ({ baseUrl }) => {
  const base = await baseUrl;

  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT }),
  });
  const loginBody = (await login.json()) as { token?: string };
  expect(loginBody.token).toBeDefined();

  await fetch(`${base}/book`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${String(loginBody.token)}` },
    body: JSON.stringify({ slot: "09:30" }),
  });
});