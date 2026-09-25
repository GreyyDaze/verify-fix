// Session store for the slots-booking example.
//
// The whole "bug" of this example lives in one rule:
//   ONE session per account — every login bumps the account's session
//   version, and only a token carrying the CURRENT version may book.
//
// Locally the store is an in-process Map. On Vercel it must be shared
// across serverless instances, so we use Upstash Redis when its env vars
// are present (either the UPSTASH_REDIS_REST_* pair or the KV_REST_API_*
// pair that Vercel's marketplace integration injects).
import { Redis } from '@upstash/redis'

export interface SessionStore {
  readonly kind: 'memory' | 'upstash'
  /** Start a new session for the account. Returns the new (current) version. */
  bumpVersion(account: string): Promise<number>
  /** The version the account's newest login produced; 0 if never logged in. */
  currentVersion(account: string): Promise<number>
}

const key = (account: string) => `acct:${account}:version`

class MemoryStore implements SessionStore {
  readonly kind = 'memory' as const
  private readonly versions = new Map<string, number>()

  async bumpVersion(account: string): Promise<number> {
    const next = (this.versions.get(key(account)) ?? 0) + 1
    this.versions.set(key(account), next)
    return next
  }

  async currentVersion(account: string): Promise<number> {
    return this.versions.get(key(account)) ?? 0
  }
}

class UpstashStore implements SessionStore {
  readonly kind = 'upstash' as const
  constructor(private readonly redis: Redis) {}

  async bumpVersion(account: string): Promise<number> {
    return this.redis.incr(key(account))
  }

  async currentVersion(account: string): Promise<number> {
    const v = await this.redis.get<number | string>(key(account))
    return v == null ? 0 : Number(v)
  }
}

function upstashFromEnv(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
  if (!url || !token) return null
  return new Redis({ url, token })
}

// Keep one instance per process (survives Next.js dev-mode module reloads).
const g = globalThis as unknown as { __slotsStore?: SessionStore }

export function getStore(): SessionStore {
  if (g.__slotsStore) return g.__slotsStore
  const redis = upstashFromEnv()
  if (redis) {
    g.__slotsStore = new UpstashStore(redis)
  } else {
    if (process.env.VERCEL) {
      console.warn(
        '[slots-booking] No Upstash/KV env vars set: sessions are per-instance memory. ' +
          'Overlapping logins on different instances will NOT collide.',
      )
    }
    g.__slotsStore = new MemoryStore()
  }
  return g.__slotsStore
}
