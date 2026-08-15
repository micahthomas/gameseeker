import { expect, test } from '@playwright/test'
import { completeProfile, goto, signIn, uniqueEmail } from './helpers'

test.describe('signing in', () => {
  test('a visitor sees the pitch and is invited to sign in', async ({ page }) => {
    await goto(page, '/')
    await expect(page.getByRole('heading', { name: 'Find a tennis game in Santa Fe' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Get started' })).toBeVisible()
    // Signed-out visitors get no member navigation.
    await expect(page.getByRole('link', { name: 'My times' })).toBeHidden()
  })

  test('a new player signs in by magic link and is walked through their profile', async ({
    page,
  }) => {
    await signIn(page, uniqueEmail('newcomer'))

    // A brand-new account is pushed to the profile before anything else,
    // because an unrated player can't be matched to anything.
    await page.waitForURL(/\/profile/)
    await expect(
      page.getByRole('heading', { name: /Welcome — tell us about your game/ }),
    ).toBeVisible()

    await completeProfile(page, { name: 'Nora Newcomer', ntrp: 3.5 })

    // Completing the profile hands off to setting availability.
    await page.waitForURL(/\/availability/)
    await expect(page.getByRole('heading', { name: 'When can you play?' })).toBeVisible()
  })

  test('an existing player signs straight back in', async ({ page }) => {
    const email = uniqueEmail('returning')
    await signIn(page, email)
    await completeProfile(page, { name: 'Rita Returning' })
    await page.waitForURL(/\/availability/)

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()

    await signIn(page, email)
    // No profile detour the second time.
    await page.waitForURL('/')
    await expect(page.getByRole('heading', { name: 'Your games' })).toBeVisible()
  })

  test('a spent magic link is refused', async ({ page }) => {
    await goto(page, '/auth/verify?token=not-a-real-token-at-all')
    await expect(page.getByRole('heading', { name: /Sign-in link didn't work/ })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible()
  })

  test('signed-out visitors are redirected away from member pages', async ({ page }) => {
    for (const path of ['/availability', '/profile', '/games/new']) {
      await page.goto(path)
      await page.waitForURL(/\/login/)
    }
  })

  test('non-admins cannot reach the admin page', async ({ page }) => {
    await signIn(page, uniqueEmail('regular'))
    await completeProfile(page, { name: 'Reg Ular' })
    await goto(page, '/admin')
    await page.waitForURL('/')
    await expect(page.getByRole('link', { name: 'Admin' })).toBeHidden()
  })
})
