import { expect, test, type Page } from '@playwright/test'
import {
  completeProfile,
  fillGame,
  dragAvailability,
  dragCourt,
  goto,
  nextWeekdayDate,
  signIn,
  toDateInputValue,
  uniqueEmail,
} from './helpers'
import type { Page as PwPage } from '@playwright/test'

/** The one block on the day grid for a given player. */
async function expectOnGrid(page: PwPage, text: string) {
  const block = page.getByTestId('court-game').filter({ hasText: text })
  await expect(block).toHaveCount(1)
  return block
}

/** Jump the day view to a date and wait for the heading to catch up. */
async function jumpTo(page: PwPage, date: Date) {
  await page.getByLabel('Jump to a date').fill(toDateInputValue(date))
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Denver' })
  await expect(page.getByTestId('day-label')).toContainText(weekday)
}

const THURSDAY = 4
const HERB_MARTINEZ = '/locations/loc-herb-martinez'

/** Seeded court ids are prefixed per location, which makes them a reliable
 *  signal that the form has caught up with a location change. */
const HERB_COURT_PREFIX = 'crt-hm-'

async function hostAt(page: PwPage, hour: number, format: 'singles' | 'doubles' = 'singles') {
  const courtPrefix = HERB_COURT_PREFIX
  await goto(page, '/games/new')
  await page.getByLabel('Location').selectOption({ label: 'Herb Martinez / La Resolana Park' })
  await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(THURSDAY)))
  await page.getByLabel('Start').selectOption(String(hour * 60))
  await page.getByRole('button', { name: format }).click()
  // Wait for the court list to belong to the location we just picked. The
  // seeded court ids carry a per-location prefix, so this is unambiguous
  // where "N courts open" alone would also match the previous location.
  await expect(page.getByTestId('courts-loading')).toHaveCount(0)
  await expect.poll(() => page.getByLabel('Court', { exact: true }).inputValue()).toContain(courtPrefix)
  await page.getByRole('button', { name: 'Post game' }).click()
  await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
}

test.describe('browsing courts', () => {
  test('the directory lists the Santa Fe facilities @mobile', async ({ page }) => {
    await goto(page, '/locations')
    await expect(page.getByRole('heading', { name: 'Courts around Santa Fe' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Salvador Perez Park/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /Herb Martinez/ })).toBeVisible()
    // Fort Marcy's tennis courts became pickleball courts, so it isn't listed.
    await expect(page.getByText('Fort Marcy')).toBeHidden()
  })

  test('a location opens on today, with a column per court', async ({ page }) => {
    await goto(page, '/locations')
    await page.getByRole('link', { name: /Herb Martinez/ }).click()

    await expect(page.getByTestId('day-label')).toContainText('Today')
    // Herb Martinez is seeded with four courts.
    await expect(page.getByTestId('court-heading')).toHaveCount(4)
    await expect(page.getByTestId('court-heading').first()).toContainText('Court 1')
  })

  test('a game reaches the calendar only once it has a court', async ({ page }) => {
    await signIn(page, uniqueEmail('grid-host'))
    await completeProfile(page, { name: 'Gina Grid', ntrp: 3.5 })
    await hostAt(page, 9)
    const gameUrl = page.url()

    // A full page load rather than a click through the directory: these
    // assertions are about the schedule's contents, and a fresh SSR render
    // takes the router's cache out of the question entirely.
    await goto(page, HERB_MARTINEZ)
    await jumpTo(page, nextWeekdayDate(THURSDAY))

    // Still looking for players, so it holds no court — but it is drawn in
    // outline on the court it would take, so the day reads as busy-ish rather
    // than empty.
    const ghost = page.getByTestId('court-game-pending').filter({ hasText: 'Gina Grid' })
    await expect(ghost).toHaveCount(1)
    await expect(ghost).toContainText('not booked yet')
    // And it isn't yet a real booking.
    await expect(
      page.getByTestId('court-game').filter({ hasText: 'Gina Grid' }),
    ).toHaveCount(0)

    await fillGame(page, gameUrl, 'Fiona Filler')

    await goto(page, HERB_MARTINEZ)
    await jumpTo(page, nextWeekdayDate(THURSDAY))

    // Now it holds the court for real, and the outline becomes a booking.
    await expect(
      page.getByTestId('court-game-pending').filter({ hasText: 'Gina Grid' }),
    ).toHaveCount(0)
    const block = await expectOnGrid(page, 'Gina Grid')
    await expect(block).toContainText('Gina Grid')
  })

  test('a full game shows both names and links to the game', async ({ page }) => {
    await signIn(page, uniqueEmail('pair-host'))
    await completeProfile(page, { name: 'Micah Host', ntrp: 3.5 })
    await hostAt(page, 11)
    const gameUrl = page.url()
    await page.getByRole('button', { name: 'Sign out' }).click()

    await signIn(page, uniqueEmail('pair-join'))
    await completeProfile(page, { name: 'Arianna Join', ntrp: 3.5 })
    await goto(page, gameUrl)
    await page.getByRole('button', { name: /claim a spot/i }).click()
    await expect(page.getByText('Full')).toBeVisible()

    await goto(page, HERB_MARTINEZ)
    await jumpTo(page, nextWeekdayDate(THURSDAY))

    const block = await expectOnGrid(page, 'Micah Host')
    await expect(block).toContainText('Micah Host & Arianna Join')

    await block.click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    await expect(page.getByText('Arianna Join')).toBeVisible()
  })

  test('two games on different courts sit in different columns', async ({ page }) => {
    await signIn(page, uniqueEmail('court-a'))
    await completeProfile(page, { name: 'Ann Court', ntrp: 3.5 })
    await hostAt(page, 15)
    const annGame = page.url()
    await fillGame(page, annGame, 'Ann Filler')

    await page.getByRole('button', { name: 'Sign out' }).click()
    await signIn(page, uniqueEmail('court-b'))
    await completeProfile(page, { name: 'Justina Court', ntrp: 3.5 })
    await hostAt(page, 15) // same hour, so it falls through to a backup court
    const justinaGame = page.url()
    await fillGame(page, justinaGame, 'Justina Filler')

    await goto(page, HERB_MARTINEZ)
    await jumpTo(page, nextWeekdayDate(THURSDAY))

    const ann = await expectOnGrid(page, 'Ann Court')
    const justina = await expectOnGrid(page, 'Justina Court')

    // Same hour, so they must be drawn side by side rather than stacked.
    const annBox = (await ann.boundingBox())!
    const justinaBox = (await justina.boundingBox())!
    expect(annBox.x).not.toBeCloseTo(justinaBox.x, 0)
    expect(annBox.y).toBeCloseTo(justinaBox.y, 0)
  })

  test('dragging a court slot offers to host there, prefilled', async ({ page }) => {
    await signIn(page, uniqueEmail('drag-host'))
    await completeProfile(page, { name: 'Dana Dragger', ntrp: 4.0 })

    await goto(page, '/locations')
    await page.getByRole('link', { name: /Atalaya Park/ }).click()
    await jumpTo(page, nextWeekdayDate(THURSDAY))

    // Second court column, 6:00-7:30pm.
    await dragCourt(page, 1, 18, 19.5 * 60 === 0 ? 19 : 19.5)

    const card = page.getByRole('dialog', { name: 'Host a game here' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('6:00 PM – 7:30 PM')
    await expect(card).toContainText('Court 2')

    await card.getByRole('link', { name: 'Host a game here' }).click()
    await page.waitForURL(/\/games\/new/)

    // The form opens already answered: location, date, start, duration, court.
    await expect(page.getByLabel('Location')).toHaveValue(/.+/)
    await expect(page.getByLabel('Start')).toHaveValue(String(18 * 60))
    await expect(page.getByText('Thu, ')).toBeVisible()
    const courtLabel = await page.getByLabel('Court', { exact: true }).inputValue()
    expect(courtLabel).toBeTruthy()

    // And posting it lands on a real game at that exact slot. The court isn't
    // held yet, so the page lists the shortlist it will be chosen from, with
    // the dragged court first.
    await page.getByRole('button', { name: 'Post game' }).click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    await expect(page.getByText(/6:00 PM – 7:30 PM/)).toBeVisible()
    await expect(page.getByText('Court confirmed once the game fills')).toBeVisible()
    await expect(
      page.getByTestId('court-options').getByRole('listitem').first(),
    ).toHaveText('Atalaya Park · Court 2')
  })

  test('the earlier of two pending games keeps the court it wanted', async ({ page }) => {
    // Neither holds anything, so both would want the best free court. The one
    // posted first is drawn taking it and the later one falls through to the
    // next court, which reads far better than two ghosts on one column.
    await signIn(page, uniqueEmail('ghost-a'))
    await completeProfile(page, { name: 'Ghosty One', ntrp: 3.5 })
    await hostAt(page, 17)
    await page.getByRole('button', { name: 'Sign out' }).click()

    await signIn(page, uniqueEmail('ghost-b'))
    await completeProfile(page, { name: 'Ghosty Two', ntrp: 3.5 })
    await hostAt(page, 17)

    await goto(page, HERB_MARTINEZ)
    await jumpTo(page, nextWeekdayDate(THURSDAY))

    const one = page.getByTestId('court-game-pending').filter({ hasText: 'Ghosty One' })
    const two = page.getByTestId('court-game-pending').filter({ hasText: 'Ghosty Two' })
    await expect(one).toHaveCount(1)
    await expect(two).toHaveCount(1)

    const oneBox = (await one.boundingBox())!
    const twoBox = (await two.boundingBox())!
    // Same hour, different court columns — and the first-posted game sits in
    // the leftmost of the two, which is the court it would actually take.
    expect(oneBox.y).toBeCloseTo(twoBox.y, 0)
    expect(oneBox.x).toBeLessThan(twoBox.x)
  })

  test('the day survives opening a game and coming back', async ({ page }) => {
    await signIn(page, uniqueEmail('back-day'))
    await completeProfile(page, { name: 'Bax Tracker', ntrp: 3.5 })
    await hostAt(page, 19)
    const gameUrl = page.url()
    await fillGame(page, gameUrl, 'Bax Filler')

    await goto(page, HERB_MARTINEZ)
    const thursday = nextWeekdayDate(THURSDAY)
    await jumpTo(page, thursday)

    // The day is in the URL, not just in component state.
    await expect(page).toHaveURL(new RegExp(`day=${toDateInputValue(thursday)}`))

    // Open the game, then press the browser's back button.
    const block = await expectOnGrid(page, 'Bax Tracker')
    await block.click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    await page.goBack()

    // Back on Thursday, not bounced to today.
    await expect(page).toHaveURL(new RegExp(`day=${toDateInputValue(thursday)}`))
    await expect(page.getByTestId('day-label')).toContainText('Thu')
    await expect(page.getByTestId('day-label')).not.toContainText('Today')
  })

  test('the day can be paged and returned to today', async ({ page }) => {
    await goto(page, '/locations')
    await page.getByRole('link', { name: /Salvador Perez/ }).click()

    const label = page.getByTestId('day-label')
    const today = (await label.textContent())!
    expect(today).toContain('Today')

    await page.getByRole('button', { name: 'Next day' }).click()
    await expect(label).not.toContainText('Today')

    await page.getByRole('button', { name: 'Previous day' }).click()
    await expect(label).toHaveText(today)

    await page.getByRole('button', { name: 'Previous day' }).click()
    await page.getByRole('button', { name: 'Today' }).click()
    await expect(label).toHaveText(today)
  })

  test('paging faster than the router settles still counts every click', async ({ page }) => {
    await goto(page, '/locations')
    await page.getByRole('link', { name: /Salvador Perez/ }).click()
    await expect(page.getByTestId('day-label')).toContainText('Today')

    // Three clicks in one task, so the component cannot re-render between
    // them. A step computed from the day this render closed over applies the
    // same +1 three times and lands on tomorrow rather than three days out.
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label="Next day"]')
      if (!button) throw new Error('no Next day button')
      for (let i = 0; i < 3; i++) button.click()
    })

    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const expected = new Date(startOfToday)
    expected.setDate(expected.getDate() + 3)
    const iso = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(
      expected.getDate(),
    ).padStart(2, '0')}`

    await expect(page).toHaveURL(new RegExp(`day=${iso}`))
  })
})

test.describe('availability heatmap', () => {
  test('shows how many players are free, and can be turned off', async ({ page }) => {
    // A player free Thursday morning at 3.5.
    await signIn(page, uniqueEmail('heat-a'))
    await completeProfile(page, { name: 'Hattie Heat', ntrp: 3.5 })
    await page.getByRole('button', { name: 'Next week' }).click()
    await dragAvailability(page, THURSDAY, 8, 11)
    await page.getByRole('button', { name: 'Every Thursday' }).click()
    await expect(page.getByText('Thursday 8:00 AM–11:00 AM')).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()

    // A host at the same level sees them on the location grid.
    await signIn(page, uniqueEmail('heat-host'))
    await completeProfile(page, { name: 'Holt Heat', ntrp: 3.5 })
    await goto(page, HERB_MARTINEZ)
    await jumpTo(page, nextWeekdayDate(THURSDAY))

    const summary = page.getByTestId('demand-summary')
    await expect(summary).toContainText(/player.* free at your levels/)
    await expect(page.getByTitle(/player.* free/).first()).toBeVisible()

    await page.getByLabel("Show who's free").uncheck()
    await expect(summary).toBeHidden()
  })

  test('counts only players at your levels unless you widen it', async ({ page }) => {
    // A 5.0 posts availability; a 3.0 host should not see them by default.
    await signIn(page, uniqueEmail('heat-strong'))
    await completeProfile(page, { name: 'Stella Strong', ntrp: 5.0, playLevels: [5.0] })
    await page.getByRole('button', { name: 'Next week' }).click()
    await dragAvailability(page, THURSDAY, 19, 21)
    await page.getByRole('button', { name: 'Every Thursday' }).click()
    await expect(page.getByText('Thursday 7:00 PM–9:00 PM')).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()

    await signIn(page, uniqueEmail('heat-weak'))
    await completeProfile(page, { name: 'Wally Weak', ntrp: 2.0, playLevels: [2.0] })
    await goto(page, HERB_MARTINEZ)
    await jumpTo(page, nextWeekdayDate(THURSDAY))

    const summary = page.getByTestId('demand-summary')
    await expect(summary).toContainText('Nobody has posted availability')

    await page.getByLabel('All levels').check()
    await expect(summary).toContainText(/player.* free\./)
  })
})
