import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { encodeToken, normalizeAccount } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  let body: unknown = null
  try { body = await req.json() } catch {}
  const account = normalizeAccount((body as { account?: unknown } | null)?.account)
  if (!account) return NextResponse.json({ error: 'account is required (letters, digits, . _ -)' }, { status: 400 })
  const store = getStore()
  const version = await store.issueSession(account)
  return NextResponse.json({ ok: true, account, version, token: encodeToken({ account, version }), store: store.kind })
}
