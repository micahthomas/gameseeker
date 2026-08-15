import path from 'node:path'
import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config'

/**
 * Tests run inside workerd against a real (in-memory) D1, not a SQLite stand-in.
 * That matters here: the guarantees this app leans on — batch() atomicity and
 * guarded-UPDATE row counts — are database behavior, and mocking them would
 * test the mock.
 *
 * Migrations are read on the Node side and handed to the worker as a binding,
 * since the worker itself has no filesystem.
 */
const migrations = await readD1Migrations(path.join(__dirname, 'drizzle/migrations'))

export default defineWorkersConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    // Unit tests only. The e2e/ directory is Playwright's, and its specs would
    // otherwise be collected here and fail on a missing test runner.
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        singleWorker: true,
        // Off because driving a Durable Object directly (runInDurableObject,
        // runDurableObjectAlarm) leaves state the per-test storage stack can't
        // unwind, and it fails the whole run. Nothing here depends on it: every
        // suite resets D1 in beforeEach, and the inbox tests address a fresh
        // player id per test.
        isolatedStorage: false,
        // The Durable Object lives in the Worker entry, so tests that drive it
        // need the entry as their main. Everything else still imports modules
        // directly.
        main: './src/server.ts',
        miniflare: {
          compatibilityDate: '2026-03-10',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: { DB: 'gameseeker-test' },
          // useSQLite mirrors `new_sqlite_classes` in wrangler.jsonc. Without
          // it the class exists but ctx.storage.sql throws.
          durableObjects: {
            PLAYER_INBOX: { className: 'PlayerInbox', useSQLite: true },
            LOCATION_HUB: { className: 'LocationHub', useSQLite: true },
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_URL: 'http://localhost:3000',
            MAIL_PROVIDER: 'console',
            SMS_PROVIDER: 'none',
            MAIL_FROM: 'GameSeeker <test@example.com>',
            TIMEZONE: 'America/Denver',
            SESSION_SECRET: 'test-only-session-secret-at-least-32-chars',
          },
        },
      },
    },
  },
})
