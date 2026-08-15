import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { completeProfile, goto, signIn, uniqueEmail } from './helpers'

/** Promote a player, the same way you would for the first real admin. */
function promoteToAdmin(email: string) {
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'gameseeker-test',
      '--local',
      '--env',
      'test',
      `--command=UPDATE users SET is_admin = 1 WHERE email = '${email}'`,
    ],
    { stdio: 'pipe' },
  )
}

test.describe('admin', () => {
  test('an admin can close a court and reopen it', async ({ page }) => {
    const email = uniqueEmail('admin')
    await signIn(page, email)
    await completeProfile(page, { name: 'Ada Admin', ntrp: 4.0 })
    promoteToAdmin(email)

    await goto(page, '/admin')
    await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible()

    const larragoite = page
      .locator('section')
      .filter({ hasText: 'Larragoite Park' })
      .first()
    // Closing a court for resurfacing takes it out of the booking form
    // without deleting the games already played on it.
    await larragoite.getByRole('button', { name: 'Close' }).first().click()
    await expect(larragoite.getByRole('button', { name: 'Reopen' })).toHaveCount(1)

    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Larragoite Park' })
    // Larragoite is seeded with two courts; one is now closed.
    await expect(page.getByText(/1 court open/)).toBeVisible()

    await goto(page, '/admin')
    await larragoite.getByRole('button', { name: 'Reopen' }).first().click()
    await expect(larragoite.getByRole('button', { name: 'Reopen' })).toHaveCount(0)
  })

  test('an admin can add a location and a court to it', async ({ page }) => {
    const email = uniqueEmail('admin-add')
    await signIn(page, email)
    await completeProfile(page, { name: 'Alex Admin', ntrp: 4.0 })
    promoteToAdmin(email)

    await goto(page, '/admin')
    // Unique per run: seeded locations survive between suites, and a repeat
    // name would make the section locator ambiguous.
    const name = `Quail Run ${Date.now()}`
    await page.getByRole('button', { name: 'Add a location' }).click()
    await page.getByPlaceholder('Name').fill(name)
    await page.getByPlaceholder('Address').fill('3101 Old Pecos Trail')
    await page.getByRole('button', { name: 'Add location' }).click()

    const quailRun = page.locator('section').filter({ hasText: name }).first()
    await expect(quailRun).toBeVisible()

    await quailRun.getByRole('button', { name: '+ Add a court' }).click()
    await quailRun.getByRole('button', { name: 'Add court' }).click()
    await expect(quailRun.getByText('Court 1')).toBeVisible()

    // It shows up for players immediately.
    await goto(page, '/locations')
    await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible()
  })

  test('an admin can grant admin to another player', async ({ page }) => {
    const email = uniqueEmail('admin-grant')
    await signIn(page, email)
    await completeProfile(page, { name: 'Grant Admin', ntrp: 4.0 })
    promoteToAdmin(email)

    await goto(page, '/admin')
    await page.getByRole('button', { name: 'Players' }).click()
    await expect(page.getByText('Grant Admin')).toBeVisible()

    const someoneElse = page.locator('li').filter({ hasText: 'Ada Admin' }).first()
    await someoneElse.getByRole('button', { name: /admin/i }).click()
    await expect(someoneElse.getByRole('button', { name: 'Remove admin' })).toBeVisible()
  })
})
