#!/usr/bin/env node
// Proves the app's behaviour at the API level, no browser needed.
//
//   node scripts/collision-check.mjs [baseUrl]      default http://localhost:3000
//
// Healthy path : one login, one booking            → 200 CONFIRMED
// Overlap path : login A, login B (same account),
//                book with A                       → 401 (superseded)
//                book with B                       → 200 CONFIRMED
//
// Exit 0 when every row matches, 1 otherwise.
const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '')
const account = process.env.TEST_USER ?? 'demo'

async function login() {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account }),
  })
  const data = await res.json()
  return { status: res.status, token: data.token, version: data.version }
}

async function book(token, slot = '09:30') {
  const res = await fetch(`${base}/api/book`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ slot }),
  })
  const data = await res.json()
  return { status: res.status, result: data.booking ?? data.error ?? '' }
}

const rows = []
function row(name, expected, actual) {
  rows.push({ name, expected, actual, ok: expected === actual })
}

const health = await (await fetch(`${base}/api/health`)).json()

// Healthy path
const h = await login()
row('healthy: login', 200, h.status)
const hb = await book(h.token)
row('healthy: book with own token', '200 CONFIRMED', `${hb.status} ${hb.result}`)

// Overlap path
const a = await login()
const b = await login()
row('overlap: B version = A version + 1', a.version + 1, b.version)
const ab = await book(a.token)
row('overlap: A books after B logged in', '401 session superseded by a newer login', `${ab.status} ${ab.result}`)
const bb = await book(b.token)
row('overlap: B books', '200 CONFIRMED', `${bb.status} ${bb.result}`)

console.log(`target ${base}  store=${health.store}  account=${account}\n`)
for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(40)} expected: ${String(r.expected).padEnd(42)} got: ${r.actual}`)
}
const failed = rows.filter((r) => !r.ok).length
console.log(`\n${rows.length - failed}/${rows.length} rows as expected`)
process.exit(failed ? 1 : 0)
