import { expect, test } from '@playwright/test'
import { completeProfile, dragAvailability, goto, signIn, uniqueEmail } from './helpers'

/** 0 = Sunday. Tuesday keeps the repeat label predictable. */
const TUESDAY = 2

/** The `week` search param, once the router has settled on one. */
async function currentWeekOf(page: import('@playwright/test').Page) {
  await expect(page).toHaveURL(/week=\d{4}-\d{2}-\d{2}/)
  return new URL(page.url()).searchParams.get('week')!
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

test.describe('painting availability on the calendar', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, uniqueEmail('calendar'))
    await completeProfile(page, { name: 'Cal Endar', ntrp: 3.5 })
    await page.waitForURL(/\/availability/)
    // Work on next week so the target day is always in the future, whatever
    // day of the week the suite happens to run on.
    await page.getByRole('button', { name: 'Next week' }).click()
  })

  test('dragging a range opens a dialog with the times that were selected', async ({ page }) => {
    await dragAvailability(page, TUESDAY, 17, 19)

    const dialog = page.getByRole('dialog', { name: 'Add this time' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('5:00 PM – 7:00 PM')
    await expect(dialog.getByRole('button', { name: 'Every Tuesday' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Just this date' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Mark as time off' })).toBeVisible()
  })

  test('“every Tuesday” creates a repeating time', async ({ page }) => {
    await dragAvailability(page, TUESDAY, 17, 19)
    await page.getByRole('button', { name: 'Every Tuesday' }).click()

    await expect(page.getByRole('heading', { name: 'Repeats every week' })).toBeVisible()
    await expect(page.getByText('Tuesday 5:00 PM–7:00 PM')).toBeVisible()

    // It survives a reload, so it really was persisted.
    await goto(page, '/availability')
    await expect(page.getByText('Tuesday 5:00 PM–7:00 PM')).toBeVisible()
  })

  test('a repeating time shows up on next week too', async ({ page }) => {
    await dragAvailability(page, TUESDAY, 17, 19)
    await page.getByRole('button', { name: 'Every Tuesday' }).click()
    await expect(page.getByText('Tuesday 5:00 PM–7:00 PM')).toBeVisible()

    const blocksThisWeek = await page.locator('[data-entry]').count()
    expect(blocksThisWeek).toBeGreaterThan(0)

    await page.getByRole('button', { name: 'Next week' }).click()
    await expect(page.locator('[data-entry]')).toHaveCount(blocksThisWeek)
  })

  test('“just this date” does not repeat', async ({ page }) => {
    await dragAvailability(page, TUESDAY, 10, 12)
    await page.getByRole('button', { name: 'Just this date' }).click()

    await expect(page.locator('[data-entry]')).toHaveCount(1)
    // No weekly rule was created.
    await expect(page.getByRole('heading', { name: 'Repeats every week' })).toBeHidden()

    await page.getByRole('button', { name: 'Next week' }).click()
    await expect(page.locator('[data-entry]')).toHaveCount(0)
  })

  test('time off is drawn differently and can be removed', async ({ page }) => {
    await dragAvailability(page, TUESDAY, 9, 11)
    await page.getByRole('button', { name: 'Mark as time off' }).click()

    const block = page.locator('[data-entry]').first()
    await expect(block).toHaveText(/Time off/)

    await block.click()
    const dialog = page.getByRole('dialog', { name: 'Edit this time' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Remove' }).click()

    await expect(page.locator('[data-entry]')).toHaveCount(0)
  })

  test('a single week of a repeating time can be skipped without losing the series', async ({
    page,
  }) => {
    await dragAvailability(page, TUESDAY, 17, 19)
    await page.getByRole('button', { name: 'Every Tuesday' }).click()
    await expect(page.getByText('Tuesday 5:00 PM–7:00 PM')).toBeVisible()

    await page.locator('[data-entry]').first().click()
    const dialog = page.getByRole('dialog', { name: 'Edit this time' })
    await expect(dialog).toContainText('Part of a weekly repeating time')
    await dialog.getByRole('button', { name: 'Skip just this week' }).click()

    // The weekly rule is intact...
    await expect(page.getByText('Tuesday 5:00 PM–7:00 PM')).toBeVisible()
    // ...but this occurrence is now covered by time off, so no green block.
    await expect(page.locator('[data-entry]').filter({ hasText: 'Time off' })).toHaveCount(1)

    // Next week is unaffected.
    await page.getByRole('button', { name: 'Next week' }).click()
    await expect(page.locator('[data-entry]').filter({ hasText: 'Time off' })).toHaveCount(0)
    await expect(page.locator('[data-entry]')).toHaveCount(1)
  })

  test('removing the series clears every week', async ({ page }) => {
    await dragAvailability(page, TUESDAY, 17, 19)
    await page.getByRole('button', { name: 'Every Tuesday' }).click()
    await expect(page.getByText('Tuesday 5:00 PM–7:00 PM')).toBeVisible()

    await page.locator('[data-entry]').first().click()
    await page
      .getByRole('dialog', { name: 'Edit this time' })
      .getByRole('button', { name: 'Remove every week' })
      .click()

    await expect(page.getByRole('heading', { name: 'Repeats every week' })).toBeHidden()
    await expect(page.locator('[data-entry]')).toHaveCount(0)
  })

  test('paging moves exactly one week and Today comes back', async ({ page }) => {
    const label = page.getByTestId('week-range')
    const currentWeek = () => currentWeekOf(page)

    // Asserted against the URL rather than the formatted label: it pins the
    // exact dates, and it auto-waits, where reading textContent straight after
    // a click races the router.
    await page.getByRole('button', { name: 'Today' }).click()
    const thisWeek = await currentWeek()

    await page.getByRole('button', { name: 'Next week' }).click()
    await expect(page).not.toHaveURL(new RegExp(`week=${thisWeek}`))
    const nextWeek = await currentWeek()
    // Exactly seven days. A week view that drifts by a day per click is the
    // bug this guards, and DST weeks are 167 or 169 hours long.
    expect(daysBetween(thisWeek, nextWeek)).toBe(7)

    // Forward then back must land exactly where it started.
    await page.getByRole('button', { name: 'Previous week' }).click()
    await expect(page).toHaveURL(new RegExp(`week=${thisWeek}`))

    await page.getByRole('button', { name: 'Next week' }).click()
    await expect(page).toHaveURL(new RegExp(`week=${nextWeek}`))

    await page.getByRole('button', { name: 'Today' }).click()
    await expect(page).toHaveURL(new RegExp(`week=${thisWeek}`))
    await expect(label).toHaveText(/\w+ \d+ – \w+ \d+/)
  })

  test('paging faster than the router settles still counts every click', async ({ page }) => {
    await page.getByRole('button', { name: 'Today' }).click()
    const start = await currentWeekOf(page)

    // Clicked from inside the page, three times in one task, so React cannot
    // re-render between them. A handler that steps from the week its render
    // closed over — rather than from the one the router currently holds —
    // applies the same +7 three times and lands one week out instead of three.
    //
    // Playwright's own click waits for actionability between calls, which is
    // usually long enough for the router to settle, so it reproduces this only
    // intermittently. Driving it from the page makes it deterministic.
    const clickTimes = (label: string, times: number) =>
      page.evaluate(
        ({ label, times }) => {
          const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
          if (!button) throw new Error(`no ${label} button`)
          for (let i = 0; i < times; i++) button.click()
        },
        { label, times },
      )

    await clickTimes('Next week', 3)
    await expect.poll(async () => daysBetween(start, await currentWeekOf(page))).toBe(21)

    await clickTimes('Previous week', 2)
    await expect.poll(async () => daysBetween(start, await currentWeekOf(page))).toBe(7)
  })

  test('the week always starts on Monday', async ({ page }) => {
    const headers = page.getByTestId('day-heading')
    await expect(headers).toHaveCount(7)
    await expect(headers.first()).toContainText('Mon')
    await expect(headers.last()).toContainText('Sun')

    // Still Monday-first after paging in both directions.
    await page.getByRole('button', { name: 'Next week' }).click()
    await expect(headers.first()).toContainText('Mon')
    await page.getByRole('button', { name: 'Previous week' }).click()
    await page.getByRole('button', { name: 'Previous week' }).click()
    await expect(headers.first()).toContainText('Mon')
  })
})

test.describe('remembering which week you were on', () => {
  test('the week survives leaving the page and coming back', async ({ page }) => {
    await signIn(page, uniqueEmail('week-memory'))
    await completeProfile(page, { name: 'Wendy Weeks', ntrp: 3.5 })

    await goto(page, '/availability')
    const thisWeek = await page.getByTestId('week-range').textContent()

    await page.getByRole('button', { name: 'Next week' }).click()
    // The week is a navigation now, and the router keeps the previous view on
    // screen until the loader resolves — so wait for the label to actually
    // move rather than for the URL alone.
    await expect(page.getByTestId('week-range')).not.toHaveText(thisWeek!)
    await expect(page).toHaveURL(/week=\d{4}-\d{2}-\d{2}/)

    const weekUrl = page.url()
    const label = await page.getByTestId('week-range').textContent()

    await goto(page, '/locations')
    await page.goBack()

    await expect(page).toHaveURL(weekUrl)
    await expect(page.getByTestId('week-range')).toHaveText(label!)
  })
})
