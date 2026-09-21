import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'

export const dynamic = 'force-dynamic'

/** GET /api/health — liveness plus which session store is in use. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    store: getStore().kind,
    slotLoadDelayMs: Number(process.env.SLOT_LOAD_DELAY_MS ?? 1500),
  })
}
