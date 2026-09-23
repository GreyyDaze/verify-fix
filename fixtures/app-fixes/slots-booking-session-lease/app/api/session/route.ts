import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { bearerToken, decodeToken } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = decodeToken(bearerToken(req))
  if (!session) return NextResponse.json({ valid: false }, { status: 401 })
  return NextResponse.json({ valid: await getStore().hasSession(session.account, session.version), account: session.account, tokenVersion: session.version })
}
