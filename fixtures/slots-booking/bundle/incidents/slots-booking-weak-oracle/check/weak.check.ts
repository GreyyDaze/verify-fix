// Weak-oracle check: only property matchers (never falsifiable). This is the
// STING "Weak Assertions" trap — the suite cannot measure what it does not
// falsify, so verdicts must cap at UNCERTAIN.

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

  const book = await fetch(`${base}/book`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${String(loginBody.token)}` },
    body: JSON.stringify({ slot: "09:30" }),
  });
  const body = (await book.json()) as { error?: string };
  expect(body).toBeTruthy();
});