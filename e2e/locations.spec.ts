import { expect, test, type Page } from '@playwright/test'
import {
  completeProfile,
  dragCourt,
  goto,
  nextWeekdayDate,
  signIn,
  toDateInputValue,
  uniqueEmail,
} from './helpers'
import type { Page as PwPage } from '@playwright/test'

/** Jump the day view to a date and wait for the heading to catch up. */
async function jumpTo(page: PwPage, date: Date) {
  await page.getByLabel('Jump to a date').fill(toDateInputValue(date))
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Denver' })
  await expect(page.getByTestId('day-label')).toContainText(weekday)
}

const THURSDAY = 4
const HERB_MARTINEZ = '/locations/loc-herb-martinez'

async function hostAt(page: Page, hour: number, format: 'singles' | 'doubles' = 'singles') {
  await goto(page, '/games/new')
  await page.getByLabel('Location').selectOption({ label: 'Herb Martinez / La Resolana Park' })
  await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(THURSDAY)))
  await page.getByLabel('Start').selectOption(String(hour * 60))
  await page.getByRole('button', { name: format }).click()
  // The court list reloads whenever the time changes; submitting mid-refresh
  // posts against a stale court selection.
  await expect(page.getByText(/courts? open/)).toBeVisible()
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

  test('booked games appear on the right court at the right time', async ({ page }) => {
    await signIn(page, uniqueEmail('grid-host'))
    await completeProfile(page, { name: 'Gina Grid', ntrp: 3.5 })
    await hostAt(page, 9)

    // A full page load rather than a click through the directory: these
    // assertions are about the schedule's contents, and a fresh SSR render
    // takes the router's cache out of the question entirely.
    await goto(page, HERB_MARTINEZ)

    // Today's view is empty; the game is on Thursday.
    await expect(page.getByTestId('court-game')).toHaveCount(0)
    await expect(page.getByText(/Every court is free|Nothing booked/)).toBeVisible()

    await jumpTo(page, nextWeekdayDate(THURSDAY))

    // Scoped by player: the day view shows every game that day, including
    // ones other tests in this file booked.
    const block = page.getByTestId('court-game').filter({ hasText: 'Gina Grid' })
    await expect(block).toHaveCount(1)
    // The block is labelled with who's playing, not an opaque id.
    await expect(block).toContainText('1 spot open')
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

    const block = page.getByTestId('court-game').filter({ hasText: 'Micah Host' })
    await expect(block).toContainText('Micah Host & Arianna Join')

    await block.click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    await expect(page.getByText('Arianna Join')).toBeVisible()
  })

  test('two games on different courts sit in different columns', async ({ page }) => {
    await signIn(page, uniqueEmail('court-a'))
    await completeProfile(page, { name: 'Ann Court', ntrp: 3.5 })
    await hostAt(page, 15)
    await page.getByRole('button', { name: 'Sign out' }).click()

    await signIn(page, uniqueEmail('court-b'))
    await completeProfile(page, { name: 'Justina Court', ntrp: 3.5 })
    await hostAt(page, 15) // same hour, so it lands on the next free court

    await goto(page, HERB_MARTINEZ)
    await jumpTo(page, nextWeekdayDate(THURSDAY))

    const ann = page.getByTestId('court-game').filter({ hasText: 'Ann Court' })
    const justina = page.getByTestId('court-game').filter({ hasText: 'Justina Court' })
    await expect(ann).toHaveCount(1)
    await expect(justina).toHaveCount(1)

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
    const courtLabel = await page.getByLabel('Court').inputValue()
    expect(courtLabel).toBeTruthy()

    // And posting it lands on a real game at that exact slot.
    await page.getByRole('button', { name: 'Post game' }).click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    await expect(page.getByText('Atalaya Park')).toBeVisible()
    await expect(page.getByText(/6:00 PM – 7:30 PM/)).toBeVisible()
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
})
