import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This app lives inside the verify-fix monorepo, which has its own
  // package-lock.json at the repo root. Pin the tracing root to this folder
  // so Next.js (locally and on Vercel) does not pick the repo root instead.
  outputFileTracingRoot: process.cwd(),
}

export default nextConfig
