// Local Stage 3 baseline: the single MultiStepCheck transaction script.
//
// This file is the check's CODE ENTRYPOINT only. It must never match
// Checkly's construct-discovery pattern (`**/*.check.{js,ts}`) — the
// construct lives in multistep-booking.check.ts and points here.
//
// Contract discipline: five ordered, awaited test.step() calls; hard
// expects only; no try/catch, no retries, no timeout changes, no skipping,
// no soft assertions, no response rewriting, no conditional control flow
// except single-line throw guards during setup (which run BEFORE any
// request). The login token exists only in runtime memory.
import { expect, test } from '@playwright/test'

// ---------------------------------------------------------------------------
// Setup — validated before any request is made. ENVIRONMENT_URL has no
// fallback: a missing or invalid value stops setup outright.
// ---------------------------------------------------------------------------
// Control characters are rejected BEFORE parsing: a URL parser can normalize
// or hide them, so they must never reach URL.canParse / new URL.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function requireHttpsOrigin(value: string, name: string): string {
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`${name} must not contain control characters`)
  if (!URL.canParse(value)) throw new Error(`${name} must be a valid absolute URL`)
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:') throw new Error(`${name} must use https`)
  if (parsed.hostname === '') throw new Error(`${name} must include a hostname`)
  if (parsed.username !== '' || parsed.password !== '') throw new Error(`${name} must not embed credentials`)
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new Error(`${name} must be a bare origin without a path`)
  if (parsed.search !== '') throw new Error(`${name} must not include a query string`)
  if (parsed.hash !== '') throw new Error(`${name} must not include a fragment`)
  return parsed.origin
}

const rawEnvironmentUrl = process.env.ENVIRONMENT_URL
if (!rawEnvironmentUrl) throw new Error('ENVIRONMENT_URL is required; this baseline has no fallback target')
const origin = requireHttpsOrigin(rawEnvironmentUrl, 'ENVIRONMENT_URL')

// One isolated monitoring account per Checkly location, selected via the
// Multistep runtime's built-in REGION variable. These accounts are separate
// from the browser check's accounts so the two scheduled checks cannot
// invalidate each other's sessions. Only the names are wired here; the
// values arrive from the environment at the later checkpoint.
const MONITORING_ACCOUNTS_BY_REGION: Record<string, string | undefined> = {
  'us-east-1': process.env.MULTISTEP_USER_US_EAST_1,
  'eu-west-1': process.env.MULTISTEP_USER_EU_WEST_1,
}
const region = process.env.REGION
const account = region === undefined ? undefined : MONITORING_ACCOUNTS_BY_REGION[region]
if (!account) throw new Error(`No multistep monitoring account is configured for region ${region ?? 'unset'}`)

const SELECTED_SLOT = '09:30'

// ---------------------------------------------------------------------------
// The ordered transaction: login -> session -> slots -> book -> confirm.
// ---------------------------------------------------------------------------
test('slots booking multistep transaction', async ({ request }) => {
  // Runtime-memory-only state shared across the ordered steps.
  let loginAccount = ''
  let loginVersion = 0
  let bearerToken = ''
  let sessionAccount = ''
  let sessionTokenVersion = 0
  let sessionCurrentVersion = 0
  let slots: string[] = []
  let bookingAccount = ''
  let bookingSlot = ''
  let bookingVersion = 0
  let bookingConfirmed = false
  let bookingResult = ''

  await test.step('login', async () => {
    const response = await request.post(`${origin}/api/login`, {
      data: { account },
    })
    expect(response.status()).toBe(200)
    const body = (await response.json()) as {
      ok?: unknown
      account?: unknown
      version?: unknown
      token?: unknown
    }
    expect(body.ok).toBe(true)
    expect(typeof body.account).toBe('string')
    expect(body.account).toBe(account)
    expect(typeof body.version).toBe('number')
    expect(body.version).toBeGreaterThan(0)
    expect(Number.isInteger(body.version)).toBe(true)
    expect(typeof body.token).toBe('string')
    expect((body.token as string).length).toBeGreaterThan(0)
    loginAccount = body.account as string
    loginVersion = body.version as number
    bearerToken = body.token as string
  })

  await test.step('session', async () => {
    const response = await request.get(`${origin}/api/session`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    })
    expect(response.status()).toBe(200)
    const body = (await response.json()) as {
      valid?: unknown
      account?: unknown
      tokenVersion?: unknown
      currentVersion?: unknown
    }
    expect(body.valid).toBe(true)
    expect(typeof body.account).toBe('string')
    expect(body.account).toBe(loginAccount)
    expect(body.tokenVersion).toBe(loginVersion)
    expect(body.currentVersion).toBe(loginVersion)
    sessionAccount = body.account as string
    sessionTokenVersion = body.tokenVersion as number
    sessionCurrentVersion = body.currentVersion as number
  })

  await test.step('slots', async () => {
    const response = await request.get(`${origin}/api/slots`)
    expect(response.status()).toBe(200)
    const body = (await response.json()) as { slots?: unknown; delayMs?: unknown }
    expect(typeof body).toBe('object')
    expect(body).not.toBeNull()
    expect(Array.isArray(body.slots)).toBe(true)
    expect(typeof body.delayMs).toBe('number')
    expect(body.slots as string[]).toContain(SELECTED_SLOT)
    slots = body.slots as string[]
  })

  await test.step('book 09:30', async () => {
    const response = await request.post(`${origin}/api/book`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      data: { slot: SELECTED_SLOT },
    })
    expect(response.status()).toBe(200)
    const body = (await response.json()) as {
      confirmed?: unknown
      booking?: unknown
      account?: unknown
      slot?: unknown
      version?: unknown
    }
    expect(body.confirmed).toBe(true)
    expect(body.booking).toBe('CONFIRMED')
    expect(typeof body.account).toBe('string')
    expect(body.account).toBe(loginAccount)
    expect(body.slot).toBe(SELECTED_SLOT)
    expect(body.slot).toBe('09:30')
    expect(body.version).toBe(loginVersion)
    bookingAccount = body.account as string
    bookingSlot = body.slot as string
    bookingVersion = body.version as number
    bookingConfirmed = body.confirmed === true
    bookingResult = body.booking as string
  })

  await test.step('confirm transaction', async () => {
    // Cross-step relationships — one session across every hop:
    expect(loginAccount).toBe(account)
    expect(sessionAccount).toBe(account)
    expect(bookingAccount).toBe(account)
    expect(sessionTokenVersion).toBe(loginVersion)
    expect(sessionCurrentVersion).toBe(loginVersion)
    expect(bookingVersion).toBe(loginVersion)
    // The selected slot came from the slots response:
    expect(slots).toContain(SELECTED_SLOT)
    // The booked slot is exactly 09:30 and the booking is confirmed:
    expect(bookingSlot).toBe('09:30')
    expect(bookingSlot).toBe(SELECTED_SLOT)
    expect(bookingConfirmed).toBe(true)
    expect(bookingResult).toBe('CONFIRMED')
  })
})
