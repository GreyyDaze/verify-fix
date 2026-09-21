// Checkly project for the slots-booking example.
//
// This is a "Playwright Check Suite": Checkly runs the standard
// @playwright/test config in ./playwright.config.ts on its own cloud runners.
// Everything the tool (verify-fix) later reads about this check — locations,
// frequency, parallelism, env-var NAMES, the spec file — comes from this file
// via `npx checkly deploy`, exactly as a customer would set it up.
//
// Docs used:
//   https://www.checklyhq.com/docs/constructs/project/
//   https://www.checklyhq.com/docs/constructs/playwright-check/
//   https://www.checklyhq.com/docs/cli/environment-variables/
import { defineConfig } from 'checkly'
import { Frequency } from 'checkly/constructs'

export default defineConfig({
  projectName: 'slots-booking (verify-fix example)',
  logicalId: 'slots-booking-monitoring',
  repoUrl: 'https://github.com/GreyyDaze/verify-fix',

  checks: {
    // Where the Playwright config lives, relative to this file.
    playwrightConfigPath: './playwright.config.ts',

    // Applies to every check in the project unless a check overrides it.
    frequency: Frequency.EVERY_5M,
    locations: ['us-east-1', 'eu-west-1'],
    tags: ['slots-booking', 'verify-fix-example'],

    playwrightChecks: [
      {
        name: 'slots booking flow',
        logicalId: 'slots-booking-flow',

        // Which Playwright project(s) from playwright.config.ts to run.
        pwProjects: ['booking'],

        frequency: Frequency.EVERY_5M,
        locations: ['us-east-1', 'eu-west-1'],

        // THE INCIDENT SEED (Phase 2 of the plan):
        //   runParallel: true  → both locations run at the same moment.
        //   Both runs log in as the same TEST_USER.
        //   The app issues one session per account (newest login wins),
        //   so the slower run books with a superseded token and gets 401.
        // Real customers do this all the time without realising it.
        runParallel: true,

        // Names only. The value below is a non-secret demo account name.
        // Real credentials would be `secret: true` and never live in git —
        // see https://www.checklyhq.com/docs/learn/playwright/authentication/
        environmentVariables: [
          { key: 'TEST_USER', value: 'demo' },
        ],
      },
    ],
  },

  cli: {
    // Location used by `npx checkly test` (ad-hoc runs, never scheduled).
    runLocation: 'eu-west-1',
    reporters: ['list'],
  },
})
