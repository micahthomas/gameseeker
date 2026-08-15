import { defineConfig, devices } from '@playwright/test'

const PORT = 3100
const BASE_URL = `http://localhost:${PORT}`

/**
 * Browser tests against the real app.
 *
 * These run on a dedicated port so they never collide with a dev server you
 * have open, and `globalSetup` migrates and clears the local D1 first so a run
 * always starts from the same state.
 *
 * Sign-in works because MAIL_PROVIDER is "console" in development: the login
 * screen renders the magic link on the page instead of emailing it, so a test
 * can click it exactly as a player would click it in their inbox.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Serial: every test shares one local D1 file, and court bookings are
  // global state. Parallel workers would fight over the same courts.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'America/Denver',
    locale: 'en-US',
  },

  projects: [
    {
      name: 'chromium',
      // Taller than the default 720 so the full 6am-10pm calendar grid is
      // reachable without scrolling mid-drag.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 1000 } },
    },
    // A phone-sized pass over the journeys most likely to happen at a court.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],

  webServer: {
    // CLOUDFLARE_ENV=test binds the gameseeker-test D1 (see wrangler.jsonc),
    // so the suite's reset step never touches your development data.
    command: `npx vite dev --port ${PORT}`,
    env: { CLOUDFLARE_ENV: 'test' },
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
