import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { bearerToken, decodeToken } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = decodeToken(bearerToken(req))
  if (!session) return NextResponse.json({ error: 'missing or malformed bearer token' }, { status: 401 })
  let slot = '09:30'
  try {
    const body = (await req.json()) as { slot?: unknown }
    if (typeof body.slot === 'string' && body.slot) slot = body.slot
  } catch {}
  const store = getStore()
  if (!(await store.consumeSession(session.account, session.version))) {
    return NextResponse.json({ error: 'session missing, expired, or already used', account: session.account, tokenVersion: session.version }, { status: 401 })
  }
  return NextResponse.json({ confirmed: true, booking: 'CONFIRMED', account: session.account, slot, version: session.version })
}
