import { expect, test } from '@playwright/test'
import { completeProfile, goto, signIn, uniqueEmail } from './helpers'

/**
 * Preferred locations, in priority order.
 *
 * The ordering's effect on matching and the dashboard is unit-tested in
 * test/preferences.test.ts; what only a browser can prove is that the list
 * survives a round trip through the form and actually reaches the rest of the
 * app.
 */
test.describe('preferred locations', () => {
  test('a player orders their courts and the choice sticks', async ({ page }) => {
    await signIn(page, uniqueEmail('prefs'))
    await completeProfile(page, { name: 'Pref Errence', ntrp: 3.5 })

    await goto(page, '/profile')
    const add = page.getByLabel('Add a preferred location')
    await add.selectOption({ label: 'Salvador Perez Park' })
    await add.selectOption({ label: 'Bicentennial / Alto Park' })

    const items = page.locator('ol li')
    await expect(items.nth(0)).toContainText('Salvador Perez Park')
    await expect(items.nth(1)).toContainText('Alto Park')

    // Promote the second one.
    await page.getByRole('button', { name: 'Move Bicentennial / Alto Park up' }).click()
    await expect(items.nth(0)).toContainText('Alto Park')

    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByText('Saved.')).toBeVisible()

    // Survives a reload, in the order chosen.
    await goto(page, '/profile')
    const reloaded = page.locator('ol li')
    await expect(reloaded.nth(0)).toContainText('Alto Park')
    await expect(reloaded.nth(1)).toContainText('Salvador Perez Park')

    // And it reaches the rest of the app: hosting opens at the top choice
    // rather than whichever location happens to sort first.
    await goto(page, '/games/new')
    await expect(page.getByLabel('Location')).toHaveValue('loc-alto')
  })

  test('a removed location disappears from the list', async ({ page }) => {
    await signIn(page, uniqueEmail('prefs-remove'))
    await completeProfile(page, { name: 'Remo Val', ntrp: 3.5 })

    await goto(page, '/profile')
    await page.getByLabel('Add a preferred location').selectOption({ label: 'Larragoite Park' })
    await expect(page.locator('ol li')).toHaveCount(1)

    await page.getByRole('button', { name: 'Remove Larragoite Park' }).click()
    await expect(page.locator('ol li')).toHaveCount(0)

    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByText('Saved.')).toBeVisible()

    await goto(page, '/profile')
    await expect(page.locator('ol li')).toHaveCount(0)
  })
})
