// Standard Playwright config. Checkly runs this file as-is on its runners
// (Playwright Check Suite). Locally you can run it too: `npx playwright test`.
import { defineConfig, devices } from '@playwright/test'

// Checkly's convention: ENVIRONMENT_URL points the check at a deployment.
//   - `npx checkly test -e ENVIRONMENT_URL=https://<preview>.vercel.app`
//   - Vercel/GitHub deployment integration sets it automatically.
// When it is not set, the check targets production.
const PRODUCTION_URL = 'https://slots-booking-verify-fix.vercel.app'

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,          // retries hide exactly the kind of bug this example has
  workers: 1,
  fullyParallel: false,
  reporter: 'list',

  use: {
    baseURL: process.env.ENVIRONMENT_URL ?? PRODUCTION_URL,
    // 'on' (not 'retain-on-failure') so that PASSING runs also keep a trace.
    // verify-fix's `bundle` command turns the trace of the last passing run
    // into recordings/passing.har and the failing run into failing.har.
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'booking',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
