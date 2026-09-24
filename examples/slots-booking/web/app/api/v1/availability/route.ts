import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { BOOKING_SLOTS } from "@/app/api/slots/catalog";

function authorized(request: Request): boolean {
  const configured = process.env.API_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!configured || !supplied) return false;
  const expected = Buffer.from(configured);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function GET(request: Request) {
  if (!process.env.API_TOKEN) {
    return NextResponse.json({ error: "API_TOKEN is not configured" }, { status: 503 });
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const slot = new URL(request.url).searchParams.get("slot");
  if (!slot) {
    return NextResponse.json({ error: "slot query parameter is required" }, { status: 400 });
  }

  const available = BOOKING_SLOTS.some((candidate) => candidate === slot);
  return NextResponse.json(
    { slot, availability: available ? "AVAILABLE" : "UNAVAILABLE" },
    { headers: { "x-request-id": request.headers.get("x-request-id") ?? "missing" } },
  );
}
