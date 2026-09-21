'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

type Booking =
  | { state: 'idle' }
  | { state: 'busy'; slot: string }
  | { state: 'done'; slot: string; status: number; result: string; detail: string }

/**
 * Booking page.
 *
 * 1. Reads the session written by the login page.
 * 2. Loads the available slots (GET /api/slots — deliberately slow; this is
 *    the race window).
 * 3. "Book 09:30" → POST /api/book with the bearer token.
 *    200 → CONFIRMED.  401 → a newer login superseded this session.
 */
export default function BookPage() {
  const [session, setSession] = useState<{
    token: string
    account: string
    version: string
    loginStatus: string
  } | null>(null)
  const [slots, setSlots] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [booking, setBooking] = useState<Booking>({ state: 'idle' })

  useEffect(() => {
    const token = sessionStorage.getItem('slots.token')
    if (!token) return
    setSession({
      token,
      account: sessionStorage.getItem('slots.account') ?? '',
      version: sessionStorage.getItem('slots.version') ?? '',
      loginStatus: sessionStorage.getItem('slots.loginStatus') ?? '',
    })
    fetch('/api/slots')
      .then(async (res) => {
        if (!res.ok) throw new Error(`slots ${res.status}`)
        const data = (await res.json()) as { slots: string[] }
        setSlots(data.slots)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [])

  async function book(slot: string) {
    if (!session) return
    setBooking({ state: 'busy', slot })
    try {
      const res = await fetch('/api/book', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ slot }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        booking?: string
        error?: string
        tokenVersion?: number
        currentVersion?: number
      }
      const result = res.ok ? (data.booking ?? 'CONFIRMED') : 'REJECTED'
      const detail = res.ok
        ? `slot ${slot} booked for ${session.account} (session v${session.version})`
        : `${data.error ?? 'error'} (token v${data.tokenVersion ?? '?'}, current v${data.currentVersion ?? '?'})`
      setBooking({ state: 'done', slot, status: res.status, result, detail })
    } catch (err) {
      setBooking({
        state: 'done',
        slot,
        status: 0,
        result: 'REJECTED',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!session) {
    return (
      <div className="card">
        <h1>Book a slot</h1>
        <p className="muted">You are not logged in.</p>
        <Link href="/">Go to login</Link>
      </div>
    )
  }

  return (
    <div className="card">
      <h1>Book a slot</h1>
      <p className="muted">
        Signed in as <strong data-testid="account">{session.account}</strong> · login{' '}
        <span data-testid="login-status">{session.loginStatus}</span> · session{' '}
        <span data-testid="session-version">v{session.version}</span>
      </p>

      {!slots && !loadError && <p className="muted" data-testid="slots-loading">Loading availability…</p>}
      {loadError && <p className="bad">Could not load slots: {loadError}</p>}

      {slots && (
        <div className="row" data-testid="slots">
          {slots.map((slot) => (
            <button
              key={slot}
              type="button"
              onClick={() => book(slot)}
              disabled={booking.state === 'busy'}
            >
              Book {slot}
            </button>
          ))}
        </div>
      )}

      {booking.state === 'done' && (
        <div className="status">
          <div>
            HTTP <span data-testid="book-status">{booking.status}</span>
          </div>
          <div className={booking.status === 200 ? 'ok' : 'bad'}>
            <span data-testid="booking-result">{booking.result}</span>
          </div>
          <div data-testid="booking-detail">{booking.detail}</div>
        </div>
      )}
      {booking.state === 'busy' && <p className="muted">Booking {booking.slot}…</p>}
    </div>
  )
}
