// Checkly project for the slots-booking example. It lives INSIDE the app
// project, next to package.json and playwright.config.ts — the layout
// Checkly's Playwright Check Suite quickstart assumes ("an existing repository
// that already contains Playwright tests").
//
// This is a "Playwright Check Suite": Checkly runs the standard
// @playwright/test config in ./playwright.config.ts on its own cloud runners
// and installs the dependencies from THIS package.json + lockfile there.
// Everything the tool (verify-fix) later reads about this check — locations,
// frequency, parallelism, env-var NAMES, the spec file — comes from this file
// via `npx checkly deploy`, exactly as a customer would set it up.
//
// Docs used:
//   https://www.checklyhq.com/docs/constructs/project/
//   https://www.checklyhq.com/docs/constructs/playwright-check/
//   https://www.checklyhq.com/docs/constructs/retry-strategy/
//   https://www.checklyhq.com/docs/cli/environment-variables/
//   https://www.checklyhq.com/docs/cli/dependencies/  (Playwright Check Suites install your package.json)
import { defineConfig } from 'checkly'
import { Frequency, RetryStrategyBuilder } from 'checkly/constructs'

// Optional: protected Vercel previews need the automation-bypass header.
// Production does not, so the variable is only deployed when it is supplied.
const automationBypass = process.env.CHECKLY_SECRET_VERCEL_AUTOMATION_BYPASS_SECRET ?? ''

export default defineConfig({
  projectName: 'slots-booking (verify-fix example)',
  logicalId: 'slots-booking-monitoring',
  repoUrl: 'https://github.com/GreyyDaze/verify-fix',

  checks: {
    // Where the Playwright config lives, relative to this file.
    playwrightConfigPath: './playwright.config.ts',
    // Checkly's recommended convention: constructs live in __checks__ folders
    // and use the *.check.ts suffix, leaving the rest of the app untouched.
    checkMatch: '**/__checks__/**/*.check.ts',

    // Applies to every check in the project unless a check overrides it.
    frequency: Frequency.EVERY_5M,
    locations: ['us-east-1', 'eu-central-1'],
    tags: ['slots-booking', 'verify-fix-example'],

    // API and Multistep checks default to one retry in another location.
    // That would hide exactly the incidents this example monitors for, so run
    // each scheduled check once. Playwright retries are set in the Playwright
    // config instead.
    retryStrategy: RetryStrategyBuilder.noRetries(),

    playwrightChecks: [
      {
        name: 'slots booking flow',
        logicalId: 'slots-booking-flow',

        // Which Playwright project(s) from playwright.config.ts to run.
        pwProjects: ['booking'],

        frequency: Frequency.EVERY_5M,
        locations: ['us-east-1', 'eu-central-1'],

        // Keep both locations concurrent. The incident used one shared
        // TEST_USER, so one login invalidated the other session. Each stable
        // Checkly location now gets its own declared user.
        runParallel: true,

        // Names only. CI supplies the regional values from its approved
        // GitHub environment. Nothing secret is committed.
        environmentVariables: [
          { key: 'TEST_USER', value: 'demo' },
          { key: 'TEST_USER_US_EAST_1', value: process.env.TEST_USER_US_EAST_1 ?? '', secret: true },
          { key: 'TEST_USER_EU_CENTRAL_1', value: process.env.TEST_USER_EU_CENTRAL_1 ?? '', secret: true },
          {
            key: 'VERCEL_AUTOMATION_BYPASS_SECRET',
            value: automationBypass,
            secret: true,
          },
        ].filter((variable) => variable.value !== ''),
      },
    ],
  },

  bundle: {
    packages: {
      // One package.json serves both the Next.js app and the check. Checkly
      // installs the bundled package.json on its runners, so drop the app's
      // runtime `dependencies` (next, react, @upstash/redis) from the BUNDLED
      // COPY only — files on disk are never modified, and the lockfile shipped
      // with the bundle is pruned to match. The spec imports only
      // @playwright/test, which stays in devDependencies.
      // (checkly ≥ 9.5: `bundle.packages.prune`, Playwright Check Suites only.)
      prune: { dependencies: true },
    },
  },

  cli: {
    // Location used by `npx checkly test` (ad-hoc runs, never scheduled).
    runLocation: 'eu-central-1',
    reporters: ['list'],
  },
})
