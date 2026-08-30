import { expect, test, type Page } from '@playwright/test'
import {
  completeProfile,
  fillGame,
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
  await expect.poll(() => page.getByLabel('Court', { exact: true }).inputValue()).toContain('crt-lg-')
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

      // A singles game is full the moment that seat goes, and the "it's on"
      // entry replaces the ordinary "someone joined" — it says everything that
      // one did plus the court, which nothing could name until now.
      await hostPage.getByRole('button', { name: /Notifications/ }).click()
      await expect(hostPage.getByText(/Your game is on at Larragoite Park/)).toBeVisible()

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
    await expect(page.getByText(/Your game is on at Larragoite Park/)).toBeVisible()
  })
})


/**
 * The live calendar.
 *
 * Same shape as the bell test: one context parks on a day view and is never
 * touched again, another posts a game there, and the first sees it arrive.
 */
test.describe('the live day view', () => {
  test('a parked calendar shows a game posted by someone else', async ({ browser }) => {
    const watcherContext = await browser.newContext()
    const hostContext = await browser.newContext()
    const watcherPage = await watcherContext.newPage()
    const hostPage = await hostContext.newPage()

    try {
      await signIn(watcherPage, uniqueEmail('cal-watcher'))
      await completeProfile(watcherPage, { name: 'Wanda Watcher', ntrp: 3.0 })

      await signIn(hostPage, uniqueEmail('cal-host'))
      await completeProfile(hostPage, { name: 'Hank Calendar', ntrp: 3.0 })

      // The watcher opens Larragoite's day view for the day the game lands on
      // and then stops interacting entirely.
      await goto(watcherPage, '/locations/loc-larragoite')
      await expect(watcherPage.getByText('Hank Calendar')).toBeHidden()

      const wednesday = nextWeekdayDate(WEDNESDAY)
      await watcherPage.getByLabel('Jump to a date').fill(toDateInputValue(wednesday))
      await expect(watcherPage.getByText('Hank Calendar')).toBeHidden()

      // Posting holds no court, so it arrives as an outline first.
      const gameUrl = await hostAt(hostPage, 15, 3.0)
      await expect(
        watcherPage.getByTestId('court-game').filter({ hasText: 'Hank Calendar' }),
      ).toHaveCount(0)

      // Filling it is what assigns a court, and turns the outline into a
      // real booking.
      await fillGame(hostPage, gameUrl, 'Cal Filler', 3.0)

      // No reload, no click: the hub said the calendar changed and the loader
      // refetched.
      await expect(watcherPage.getByText('Hank Calendar')).toBeVisible({ timeout: 15_000 })
    } finally {
      await watcherPage.close()
      await hostPage.close()
      await watcherContext.close()
      await hostContext.close()
    }
  })
})
