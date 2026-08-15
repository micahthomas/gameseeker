import { execFileSync } from 'node:child_process'

/**
 * Put the local D1 into a known state before the suite runs: schema up to
 * date, courts seeded, and no players or games left over from last time.
 */
export default function globalSetup() {
  const run = (args: string[]) => {
    execFileSync('npx', ['wrangler', ...args], { stdio: 'pipe', encoding: 'utf8' })
  }

  // gameseeker-test, not gameseeker: the suite clears players and sessions,
  // and doing that to the development database logs you out every run.
  const db = ['--env', 'test']
  run(['d1', 'migrations', 'apply', 'gameseeker-test', '--local', ...db])
  run(['d1', 'execute', 'gameseeker-test', '--local', ...db, '--file=./drizzle/reset.sql'])
  // Also drop courts and locations, which reset.sql deliberately keeps for
  // development use. Admin tests add facilities, and seed.sql is INSERT OR
  // IGNORE, so without this the test database accumulates across runs.
  run([
    'd1',
    'execute',
    'gameseeker-test',
    '--local',
    ...db,
    '--command=DELETE FROM courts; DELETE FROM locations;',
  ])
  run(['d1', 'execute', 'gameseeker-test', '--local', ...db, '--file=./drizzle/seed.sql'])
}
