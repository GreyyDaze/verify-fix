// Session tokens are deliberately readable: `tok-<account>-<version>`.
// This is a demo app with no real data. A readable token lets anyone
// looking at a HAR file or a Checkly trace see the story at a glance:
// "run A booked with v1 after run B's login had moved the account to v2".

export interface Session {
  account: string
  version: number
}

const ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i

export function normalizeAccount(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const account = input.trim()
  return ACCOUNT_RE.test(account) ? account : null
}

export function encodeToken(session: Session): string {
  return `tok-${session.account}-${session.version}`
}

export function decodeToken(token: string | null | undefined): Session | null {
  if (!token) return null
  const m = /^tok-(.+)-(\d+)$/.exec(token)
  if (!m) return null
  const account = normalizeAccount(m[1])
  if (!account) return null
  return { account, version: Number(m[2]) }
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(header)
  return m ? m[1].trim() : null
}
