// The real Checkly check for the slots-booking example.
//
// Four alarms, in the order a user would hit them:
//   1. login call answered 200
//   2. app moved to the booking page
//   3. booking call answered 200
//   4. booking result reads CONFIRMED
//
// Assertions are deliberately explicit (no `if`, no try/catch, no soft
// expects). This is the "good" version of the check; the incident and the
// candidate fixes come later in the plan.
import { test, expect } from '@playwright/test'

// Set by Checkly (check-level environment variable), by `checkly test -e`,
// or by the shell when running locally. Never hard-code accounts.
// GOOD FIX: each stable Checkly location reads its own declared account.
// No account is generated during a run.
const TEST_USERS_BY_REGION: Record<string, string | undefined> = {
  'us-east-1': process.env.TEST_USER_US_EAST_1,
  'eu-west-1': process.env.TEST_USER_EU_WEST_1,
}
const TEST_USER = TEST_USERS_BY_REGION[process.env.CHECKLY_REGION ?? '']

if (!TEST_USER) throw new Error(`No declared test user is configured for region ${process.env.CHECKLY_REGION ?? 'unset'}`)

test.describe('slots booking flow', () => {
  test('log in and book the 09:30 slot', async ({ page }) => {
    // baseURL comes from playwright.config.ts (ENVIRONMENT_URL or production).
    await page.goto('/')

    await page.getByLabel('Account').fill(TEST_USER)
    await page.getByRole('button', { name: 'Log in' }).click()

    // 1. login answered 200
    await expect(page.getByTestId('login-status')).toHaveText('200')

    // 2. we are on the booking page
    await expect(page).toHaveURL(/\/book$/)
    await expect(page.getByRole('heading', { name: 'Book a slot' })).toBeVisible()

    await page.getByRole('button', { name: 'Book 09:30' }).click()

    // 3. booking answered 200
    await expect(page.getByTestId('booking-status')).toHaveText('200')

    // 4. booking confirmed
    await expect(page.getByTestId('booking-result')).toHaveText('CONFIRMED')
  })
})
