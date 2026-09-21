import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { encodeToken, normalizeAccount } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * POST /api/login  { account: string }
 *
 * Starts a NEW session for the account and returns its token.
 * Rule of this app: the newest login wins. Any token issued earlier for the
 * same account stops working the moment this call succeeds.
 */
export async function POST(req: Request) {
  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    // fall through: missing/invalid JSON handled below
  }
  const account = normalizeAccount((body as { account?: unknown } | null)?.account)
  if (!account) {
    return NextResponse.json(
      { error: 'account is required (letters, digits, . _ -)' },
      { status: 400 },
    )
  }

  const store = getStore()
  const version = await store.bumpVersion(account)
  const token = encodeToken({ account, version })

  return NextResponse.json({ ok: true, account, version, token, store: store.kind })
}
