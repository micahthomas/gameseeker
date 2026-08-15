import { expect, test, type Page } from '@playwright/test'
import {
  completeProfile,
  goto,
  nextWeekdayDate,
  signIn,
  toDateInputValue,
  uniqueEmail,
} from './helpers'

const WEDNESDAY = 3

/**
 * The notification bell.
 *
 * The assertion that matters is the last one: a second browser context, whose
 * page is never reloaded, sees its badge appear because a Durable Object
 * pushed down an open WebSocket. That is the whole feature in one expectation
 * — everything else here is setup to reach it.
 */

async function hostAt(page: Page, hour: number, level = 3.5) {
  await goto(page, '/games/new')
  await page.getByLabel('Location').selectOption({ label: 'Larragoite Park' })
  await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
  await page.getByLabel('Start').selectOption(String(hour * 60))
  await page.getByRole('button', { name: 'singles' }).click()

  const seatSelects = page.locator('select[id^="level-"]')
  for (let i = 0; i < (await seatSelects.count()); i++) {
    await seatSelects.nth(i).selectOption(String(level))
  }
  await expect(page.getByTestId('courts-loading')).toHaveCount(0)
  await expect.poll(() => page.getByLabel('Court').inputValue()).toContain('crt-lg-')
  await page.getByRole('button', { name: 'Post game' }).click()
  await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
  return page.url()
}

test.describe('the notification bell', () => {
  test('a host is told, live, when someone takes a seat', async ({ browser }) => {
    // Two contexts so both players stay signed in at once — the point is that
    // one of them is *watching* while the other acts.
    const hostContext = await browser.newContext()
    const joinerContext = await browser.newContext()
    const hostPage = await hostContext.newPage()
    const joinerPage = await joinerContext.newPage()

    try {
      await signIn(hostPage, uniqueEmail('bell-host'))
      await completeProfile(hostPage, { name: 'Bella Host', ntrp: 3.5 })
      const gameUrl = await hostAt(hostPage, 7)

      await signIn(joinerPage, uniqueEmail('bell-joiner'))
      await completeProfile(joinerPage, { name: 'Jo Bell', ntrp: 3.5 })

      // The host parks on their dashboard and does not touch it again.
      await goto(hostPage, '/')
      await expect(hostPage.getByTestId('inbox')).toBeVisible()
      await expect(hostPage.getByTestId('inbox-unread')).toBeHidden()

      await goto(joinerPage, gameUrl)
      await joinerPage.getByRole('button', { name: /claim a spot/i }).click()
      await expect(joinerPage.getByText('Jo Bell')).toBeVisible()

      // No reload, no navigation: the badge arrives over the socket.
      await expect(hostPage.getByTestId('inbox-unread')).toBeVisible({ timeout: 15_000 })

      // And the entry itself says who joined.
      await hostPage.getByRole('button', { name: /Notifications/ }).click()
      await expect(hostPage.getByText('Jo Bell joined your game')).toBeVisible()

      // Opening the bell marks it read, and the badge clears.
      await expect(hostPage.getByTestId('inbox-unread')).toBeHidden()
    } finally {
      // Close the pages before their contexts: each holds an open WebSocket,
      // and leaving them dangling wedges the single-worker dev server for
      // whatever runs next.
      await hostPage.close()
      await joinerPage.close()
      await hostContext.close()
      await joinerContext.close()
    }
  })

  test('the joiner keeps their own confirmation, and it survives a reload', async ({ page }) => {
    await signIn(page, uniqueEmail('bell-solo-host'))
    await completeProfile(page, { name: 'Solo Host', ntrp: 4.0 })
    const gameUrl = await hostAt(page, 9, 4.0)
    await page.getByRole('button', { name: 'Sign out' }).click()

    await signIn(page, uniqueEmail('bell-solo-joiner'))
    await completeProfile(page, { name: 'Solo Joiner', ntrp: 4.0 })
    await goto(page, gameUrl)
    await page.getByRole('button', { name: /claim a spot/i }).click()

    // Durable, not just live: a full reload still shows it.
    await goto(page, '/')
    await expect(page.getByTestId('inbox-unread')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: /Notifications/ }).click()
    await expect(page.getByText(/You're in at Larragoite Park/)).toBeVisible()
  })
})
