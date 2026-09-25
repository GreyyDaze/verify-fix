import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { bearerToken, decodeToken } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * POST /api/book  { slot: string }   Authorization: Bearer tok-<account>-<version>
 *
 * 200 { confirmed: true, booking: "CONFIRMED", ... } when the token carries the
 *     account's CURRENT session version.
 * 401 when a newer login has happened since this token was issued
 *     (this is the incident the monitoring check catches).
 */
export async function POST(req: Request) {
  const session = decodeToken(bearerToken(req))
  if (!session) {
    return NextResponse.json({ error: 'missing or malformed bearer token' }, { status: 401 })
  }

  let slot = '09:30'
  try {
    const body = (await req.json()) as { slot?: unknown }
    if (typeof body.slot === 'string' && body.slot) slot = body.slot
  } catch {
    // no body → default slot
  }

  const store = getStore()
  const current = await store.currentVersion(session.account)
  if (session.version !== current) {
    return NextResponse.json(
      {
        error: 'session superseded by a newer login',
        account: session.account,
        tokenVersion: session.version,
        currentVersion: current,
      },
      { status: 401 },
    )
  }

  return NextResponse.json({
    confirmed: true,
    booking: 'CONFIRMED',
    account: session.account,
    slot,
    version: session.version,
  })
}
