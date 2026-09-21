import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { bearerToken, decodeToken } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * GET /api/session   Authorization: Bearer tok-<account>-<version>
 *
 * Read-only diagnostic: is this token still the account's current session?
 * Handy when reading traces: it shows both versions side by side.
 */
export async function GET(req: Request) {
  const session = decodeToken(bearerToken(req))
  if (!session) {
    return NextResponse.json({ valid: false, error: 'missing or malformed bearer token' }, { status: 401 })
  }
  const current = await getStore().currentVersion(session.account)
  return NextResponse.json({
    valid: session.version === current,
    account: session.account,
    tokenVersion: session.version,
    currentVersion: current,
  })
}
