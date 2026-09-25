// GOOD APP FIX: every login receives an independent short-lived session lease.
// Upstash holds the lease in production. Memory provides the same behavior for
// local verification. A process-local mutex would not work across Vercel instances.
import { Redis } from '@upstash/redis'

const LEASE_SECONDS = 300
const versionKey = (account: string) => `acct:${account}:version`
const leaseKey = (account: string, version: number) => `acct:${account}:session:${version}`

export interface SessionStore {
  readonly kind: 'memory' | 'upstash'
  issueSession(account: string): Promise<number>
  hasSession(account: string, version: number): Promise<boolean>
  consumeSession(account: string, version: number): Promise<boolean>
  currentVersion(account: string): Promise<number>
}

class MemoryStore implements SessionStore {
  readonly kind = 'memory' as const
  private readonly versions = new Map<string, number>()
  private readonly leases = new Map<string, number>()

  async issueSession(account: string): Promise<number> {
    const next = (this.versions.get(versionKey(account)) ?? 0) + 1
    this.versions.set(versionKey(account), next)
    this.leases.set(leaseKey(account, next), Date.now() + LEASE_SECONDS * 1000)
    return next
  }

  async hasSession(account: string, version: number): Promise<boolean> {
    const key = leaseKey(account, version)
    const expiry = this.leases.get(key) ?? 0
    if (expiry <= Date.now()) this.leases.delete(key)
    return expiry > Date.now()
  }

  async consumeSession(account: string, version: number): Promise<boolean> {
    if (!(await this.hasSession(account, version))) return false
    return this.leases.delete(leaseKey(account, version))
  }

  async currentVersion(account: string): Promise<number> {
    return this.versions.get(versionKey(account)) ?? 0
  }
}

class UpstashStore implements SessionStore {
  readonly kind = 'upstash' as const
  constructor(private readonly redis: Redis) {}

  async issueSession(account: string): Promise<number> {
    const version = await this.redis.incr(versionKey(account))
    await this.redis.set(leaseKey(account, version), '1', { ex: LEASE_SECONDS })
    return version
  }

  async hasSession(account: string, version: number): Promise<boolean> {
    return (await this.redis.exists(leaseKey(account, version))) === 1
  }

  async consumeSession(account: string, version: number): Promise<boolean> {
    // GETDEL is atomic. Only one booking can consume a lease.
    return (await this.redis.getdel(leaseKey(account, version))) !== null
  }

  async currentVersion(account: string): Promise<number> {
    const value = await this.redis.get<number | string>(versionKey(account))
    return value == null ? 0 : Number(value)
  }
}

function upstashFromEnv(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
  return url && token ? new Redis({ url, token }) : null
}

const globalStore = globalThis as unknown as { __slotsLeaseStore?: SessionStore }
export function getStore(): SessionStore {
  if (globalStore.__slotsLeaseStore) return globalStore.__slotsLeaseStore
  const redis = upstashFromEnv()
  globalStore.__slotsLeaseStore = redis ? new UpstashStore(redis) : new MemoryStore()
  return globalStore.__slotsLeaseStore
}
