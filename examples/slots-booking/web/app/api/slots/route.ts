import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SLOTS = ['09:30', '10:00', '10:30']

/**
 * GET /api/slots
 *
 * Returns today's bookable slots after a deliberate delay. The delay stands
 * in for the "load availability" step of a real booking app and is the width
 * of the race window between two overlapping monitoring runs
 * (login → wait for slots → book). Default 1500 ms.
 */
export async function GET() {
  const delay = Number(process.env.SLOT_LOAD_DELAY_MS ?? 1500)
  if (delay > 0) await new Promise((r) => setTimeout(r, delay))
  return NextResponse.json({ slots: SLOTS, delayMs: delay })
}
