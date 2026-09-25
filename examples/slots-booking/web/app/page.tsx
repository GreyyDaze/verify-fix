'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Login page.
 *
 * POST /api/login starts a NEW session for the account (newest login wins).
 * On success the token and the HTTP status are kept in sessionStorage and
 * the app moves to /book, where the monitoring check reads them.
 */
export default function LoginPage() {
  const router = useRouter()
  const [account, setAccount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        token?: string
        version?: number
        error?: string
      }
      if (!res.ok || !data.token) {
        setError(`login failed: ${res.status} ${data.error ?? ''}`.trim())
        return
      }
      sessionStorage.setItem('slots.token', data.token)
      sessionStorage.setItem('slots.account', account)
      sessionStorage.setItem('slots.version', String(data.version ?? ''))
      sessionStorage.setItem('slots.loginStatus', String(res.status))
      router.push('/book')
    } catch (err) {
      setError(`login failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h1>Slots</h1>
      <p className="muted">Log in to book a time slot. One active session per account — the newest login wins.</p>
      <form onSubmit={onSubmit}>
        <label htmlFor="account">Account</label>
        <input
          id="account"
          name="account"
          autoComplete="username"
          placeholder="demo"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          required
        />
        <div className="row">
          <button type="submit" disabled={busy || account.trim() === ''}>
            {busy ? 'Logging in…' : 'Log in'}
          </button>
        </div>
      </form>
      {error && (
        <div className="status bad" data-testid="login-error">
          {error}
        </div>
      )}
    </div>
  )
}
