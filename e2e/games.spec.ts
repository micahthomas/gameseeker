import { expect, test, type Page } from '@playwright/test'
import {
  completeProfile,
  dragAvailability,
  fillGame,
  goto,
  nextWeekdayDate,
  signIn,
  toDateInputValue,
  uniqueEmail,
} from './helpers'

const WEDNESDAY = 3

/**
 * How many courts `drizzle/seed.sql` gives Salvador Perez. The tests below
 * assert on "N courts open" to prove a court was taken or released, so this
 * has to track the seed — keep it here rather than inline, because the last
 * time the seeded inventory changed these were the two tests that broke.
 */
const SALVADOR_PEREZ_COURTS = 4

/**
 * Post a game at Salvador Perez on the next Wednesday.
 *
 * Every test passes its own `hour`, spaced two hours apart: the suite shares
 * one database, a court booking is global state, and games run 90 minutes by
 * default — so consecutive hours would overlap and eat each other's courts.
 */
async function hostGame(
  page: Page,
  options: { hour: number; format?: 'singles' | 'doubles'; level?: number; note?: string },
) {
  const level = options.level ?? 3.5
  const courtPrefix = 'crt-sp-' // Salvador Perez
  await goto(page, '/games/new')

  await page.getByLabel('Location').selectOption({ label: 'Salvador Perez Park' })
  await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
  await page.getByLabel('Start').selectOption(String(options.hour * 60))
  await page.getByRole('button', { name: options.format ?? 'singles' }).click()

  // Seat pickers appear per format; set every seeker seat to the same level.
  const seatSelects = page.locator('select[id^="level-"]')
  for (let i = 0; i < (await seatSelects.count()); i++) {
    await seatSelects.nth(i).selectOption(String(level))
  }

  if (options.note) await page.getByLabel(/Note for players/).fill(options.note)
  // Wait for the court list to belong to the location we just picked. The
  // seeded court ids carry a per-location prefix, so this is unambiguous
  // where "N courts open" alone would also match the previous location.
  await expect(page.getByTestId('courts-loading')).toHaveCount(0)
  await expect.poll(() => page.getByLabel('Court', { exact: true }).inputValue()).toContain(courtPrefix)
  await page.getByRole('button', { name: 'Post game' }).click()
  await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
}

test.describe('hosting and joining a game', () => {
  test('a host posts a game and a matched player is told how many will hear about it', async ({
    page,
  }) => {
    // A player who is free Wednesday evening at 3.5.
    await signIn(page, uniqueEmail('willing'))
    await completeProfile(page, { name: 'Wanda Willing', ntrp: 3.5 })
    await page.waitForURL(/\/availability/)
    await page.getByRole('button', { name: 'Next week' }).click()
    await dragAvailability(page, WEDNESDAY, 16, 20)
    await page.getByRole('button', { name: 'Every Wednesday' }).click()
    await expect(page.getByText('Wednesday 4:00 PM–8:00 PM')).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()

    // The host sees a live count of who would be notified before posting.
    await signIn(page, uniqueEmail('host'))
    await completeProfile(page, { name: 'Hank Host', ntrp: 3.5 })
    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Salvador Perez Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(17 * 60))
    await page.getByRole('button', { name: 'singles' }).click()

    // The availability posted above covers Wednesday 4-8pm, so this reaches her.
    await expect(page.getByText(/will be notified/)).toBeVisible()
    await page.getByRole('button', { name: 'Post game' }).click()
    await page.waitForURL(/\/games\//)

    await expect(page.getByRole('heading', { name: /:00/ })).toBeVisible()
    await expect(page.getByText('GameSeeker 3.5')).toBeVisible()
    await expect(page.getByText('Hank Host')).toBeVisible()
  })

  test('a court is only off the list once a game has actually taken it', async ({ page }) => {
    await signIn(page, uniqueEmail('first'))
    await completeProfile(page, { name: 'First Host', ntrp: 4.0 })
    await hostGame(page, { hour: 8, level: 4.0 })
    const gameUrl = page.url()

    await page.getByRole('button', { name: 'Sign out' }).click()

    // While that game is still looking for players it holds nothing, so a
    // second host is offered every court — including the one the first host
    // put at the top of their list.
    await signIn(page, uniqueEmail('second'))
    await completeProfile(page, { name: 'Second Host', ntrp: 4.0 })
    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Salvador Perez Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(8 * 60))
    await expect(page.getByText(`${SALVADOR_PEREZ_COURTS} courts open`)).toBeVisible()

    // Fill the first game; now it really does hold a court.
    await fillGame(page, gameUrl, 'Eighth Filler', 4.0)

    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Salvador Perez Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(8 * 60))
    await expect(page.getByText(`${SALVADOR_PEREZ_COURTS - 1} courts open`)).toBeVisible()
    const options = await page
      .getByLabel('Court', { exact: true })
      .locator('option')
      .allTextContents()
    expect(options).toHaveLength(SALVADOR_PEREZ_COURTS - 1)
  })

  test('a matched player claims the open spot and the game fills', async ({ page }) => {
    await signIn(page, uniqueEmail('joiner'))
    await completeProfile(page, { name: 'Jo Joiner', ntrp: 3.5, phone: '505-555-0142' })
    await page.getByRole('button', { name: 'Sign out' }).click()

    await signIn(page, uniqueEmail('hoster'))
    await completeProfile(page, { name: 'Holly Hoster', ntrp: 3.5, phone: '505-555-0111' })
    await hostGame(page, { hour: 10, note: 'Bring a can of balls' })
    const gameUrl = page.url()
    await expect(page.getByText('Bring a can of balls')).toBeVisible()
    await expect(page.getByText(/1 spot open/)).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()

    // The joiner takes the seat.
    await signIn(page, 'jo-joiner-known@santafe.test')
    await completeProfile(page, { name: 'Jo Joiner Two', ntrp: 3.5, phone: '505-555-0142' })
    await goto(page, gameUrl)
    await page.getByRole('button', { name: /claim a spot/i }).click()

    await expect(page.getByText('Full')).toBeVisible()
    await expect(page.getByText('Jo Joiner Two')).toBeVisible()
    // Names and levels only. Phone numbers are never shown to other players,
    // not even teammates — a game page is readable by anyone with the link.
    await expect(page.getByText('505-555-0111')).toBeHidden()
    await expect(page.getByText('505-555-0142')).toBeHidden()
  })

  test('a player who did not opt into the level cannot claim', async ({ page }) => {
    await signIn(page, uniqueEmail('strong-host'))
    await completeProfile(page, { name: 'Strong Host', ntrp: 4.5 })
    await hostGame(page, { hour: 12, level: 4.5 })
    const gameUrl = page.url()
    await page.getByRole('button', { name: 'Sign out' }).click()

    // A 3.0 who only plays 3.0 is told what the game wants, with no claim button.
    await signIn(page, uniqueEmail('beginner'))
    await completeProfile(page, { name: 'Bea Ginner', ntrp: 3.0, playLevels: [3.0] })
    await goto(page, gameUrl)

    await expect(page.getByRole('button', { name: /claim a spot/i })).toBeHidden()
    await expect(page.getByText(/looking for 4\.5 players/)).toBeVisible()
  })

  test('a player who opted into a higher level can claim it', async ({ page }) => {
    await signIn(page, uniqueEmail('four-host'))
    await completeProfile(page, { name: 'Four Host', ntrp: 4.0 })
    await hostGame(page, { hour: 14, level: 4.0 })
    const gameUrl = page.url()
    await page.getByRole('button', { name: 'Sign out' }).click()

    // A 3.5 who said they'll also play 4.0 is welcome.
    await signIn(page, uniqueEmail('plays-up'))
    await completeProfile(page, { name: 'Pat PlaysUp', ntrp: 3.5, playLevels: [3.5, 4.0] })
    await goto(page, gameUrl)
    await page.getByRole('button', { name: /claim a spot/i }).click()
    await expect(page.getByText('Pat PlaysUp')).toBeVisible()
    await expect(page.getByText('Full')).toBeVisible()
  })

  test('the host can cancel, which frees the court', async ({ page }) => {
    await signIn(page, uniqueEmail('canceller'))
    await completeProfile(page, { name: 'Cass Canceller', ntrp: 3.0 })
    await hostGame(page, { hour: 20, level: 3.0 })

    await page.getByRole('button', { name: 'Cancel this game' }).click()
    await page.getByPlaceholder(/Reason/).fill('Rain')
    await page.getByRole('button', { name: 'Cancel game' }).click()

    await expect(page.getByText('Cancelled')).toBeVisible()
    // The court is back in the pool for that slot.
    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Salvador Perez Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(20 * 60))
    await expect(page.getByText(`${SALVADOR_PEREZ_COURTS} courts open`)).toBeVisible()
  })

  test('a doubles game opens three seats @mobile', async ({ page }) => {
    await signIn(page, uniqueEmail('doubles'))
    await completeProfile(page, { name: 'Dub Bles', ntrp: 3.5 })
    await hostGame(page, { hour: 6, format: 'doubles' })

    await expect(page.getByText(/3 spots open/)).toBeVisible()
    await expect(page.getByText('GameSeeker 3.5')).toHaveCount(3)
  })
})

/** Post a singles game at Larragoite, returning its URL. */
async function hostAtLarragoite(page: Page, hour: number, level: number) {
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

test.describe('mixed doubles', () => {
  test('a mixed game holds seats to keep the teams even', async ({ page }) => {
    await signIn(page, uniqueEmail('mixed-host'))
    await completeProfile(page, { name: 'Manny Mixed', ntrp: 3.5, division: 'mens' })

    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Salvador Perez Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(16 * 60))
    await page.getByRole('button', { name: 'doubles' }).click()
    await page.getByLabel('Mixed doubles').check()

    // A men's-division host means two women's seats and one men's.
    await expect(page.getByText(/play women's tennis will be messaged/)).toHaveCount(2)
    await expect(page.getByText(/play men's tennis will be messaged/)).toHaveCount(1)

    await page.getByRole('button', { name: 'Post game' }).click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    const gameUrl = page.url()

    await expect(page.getByText('Mixed doubles')).toBeVisible()
    await expect(page.getByText(/· a women's player/)).toHaveCount(2)
    await page.getByRole('button', { name: 'Sign out' }).click()

    // A men's-division player cannot take a seat held for the women's side.
    await signIn(page, uniqueEmail('mixed-man'))
    await completeProfile(page, { name: 'Other Man', ntrp: 3.5, division: 'mens' })
    await goto(page, gameUrl)
    await page.getByRole('button', { name: /claim a spot/i }).click()
    await expect(page.getByText(/· a men's player/)).toHaveCount(0)
    await page.getByRole('button', { name: 'Sign out' }).click()

    // A woman can.
    await signIn(page, uniqueEmail('mixed-woman'))
    await completeProfile(page, { name: 'Wanda Mixed', ntrp: 3.5, division: 'womens' })
    await goto(page, gameUrl)
    await page.getByRole('button', { name: /claim a spot/i }).click()
    await expect(page.getByText('Wanda Mixed')).toBeVisible()
  })

  test('a player who opted out of mixed is not offered the game', async ({ page }) => {
    await signIn(page, uniqueEmail('mixed-host2'))
    await completeProfile(page, { name: 'Hosty Mixed', ntrp: 4.0, division: 'womens' })

    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Salvador Perez Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(18 * 60))
    await page.getByRole('button', { name: 'doubles' }).click()
    await page.getByLabel('Mixed doubles').check()
    await page.getByRole('button', { name: 'Post game' }).click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    const gameUrl = page.url()
    await page.getByRole('button', { name: 'Sign out' }).click()

    await signIn(page, uniqueEmail('no-mixed'))
    await completeProfile(page, { name: 'Nomi Mixed', ntrp: 4.0, division: 'mens', mixed: false })
    await goto(page, gameUrl)
    await expect(page.getByRole('button', { name: /claim a spot/i })).toBeHidden()
  })

  test('the mixed option follows the chosen format', async ({ page }) => {
    await signIn(page, uniqueEmail('mixed-toggle'))
    await completeProfile(page, { name: 'Toggle Tess', ntrp: 3.0, division: 'womens' })
    await goto(page, '/games/new')

    // Mixed used to be doubles-only. It now exists in both branches, and the
    // label tracks the format toggle.
    await page.getByRole('button', { name: 'singles' }).click()
    await expect(page.getByLabel('Mixed singles')).toBeVisible()
    await page.getByRole('button', { name: 'doubles' }).click()
    await expect(page.getByLabel('Mixed doubles')).toBeVisible()
  })
})

test.describe('mixed singles', () => {
  test('a mixed singles game holds its one seat for the other division', async ({ page }) => {
    await signIn(page, uniqueEmail('ms-host'))
    await completeProfile(page, { name: 'Mona Single', ntrp: 3.5, division: 'womens' })

    await goto(page, '/games/new')
    // A different park, because Salvador Perez's Wednesday is fully booked by
    // the other specs and court holds are global to this shared database.
    await page.getByLabel('Location').selectOption({ label: 'Herb Martinez / La Resolana Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(13 * 60))
    await page.getByRole('button', { name: 'singles' }).click()
    await page.getByLabel('Mixed singles').check()

    // One seat, held for the men's side, because the host plays women's.
    await expect(page.getByText(/play men's tennis will be messaged/)).toHaveCount(1)

    await page.getByRole('button', { name: 'Post game' }).click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    const gameUrl = page.url()
    await expect(page.getByText('Mixed singles')).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()

    // Another women's player cannot take the seat held for the men's side.
    await signIn(page, uniqueEmail('ms-woman'))
    await completeProfile(page, { name: 'Wilma Single', ntrp: 3.5, division: 'womens' })
    await goto(page, gameUrl)
    await expect(page.getByRole('button', { name: /claim a spot/i })).toBeHidden()
    await page.getByRole('button', { name: 'Sign out' }).click()

    // A man who opted into mixed singles can.
    await signIn(page, uniqueEmail('ms-man'))
    await completeProfile(page, { name: 'Marco Single', ntrp: 3.5, division: 'mens' })
    await goto(page, gameUrl)
    await page.getByRole('button', { name: /claim a spot/i }).click()
    await expect(page.getByText('Marco Single')).toBeVisible()
  })

  test('a player who did not opt into mixed singles is not offered the game', async ({ page }) => {
    await signIn(page, uniqueEmail('ms-host2'))
    await completeProfile(page, { name: 'Hana Single', ntrp: 4.5, division: 'womens' })

    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Herb Martinez / La Resolana Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(19 * 60))
    await page.getByRole('button', { name: 'singles' }).click()
    await page.getByLabel('Mixed singles').check()
    await page.getByRole('button', { name: 'Post game' }).click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    const gameUrl = page.url()
    await page.getByRole('button', { name: 'Sign out' }).click()

    await signIn(page, uniqueEmail('ms-plain'))
    await completeProfile(page, {
      name: 'Plain Singleton',
      ntrp: 4.5,
      division: 'mens',
      mixedSingles: false,
    })
    await goto(page, gameUrl)
    await expect(page.getByRole('button', { name: /claim a spot/i })).toBeHidden()
  })
})


test.describe('offering courts at more than one park', () => {
  test('a game can fall through to another location when the first is taken', async ({ page }) => {
    // Larragoite has two courts. Fill both for this hour so nothing is left
    // there, and the game has to land at the second park the host offered.
    await signIn(page, uniqueEmail('multi-block-a'))
    await completeProfile(page, { name: 'Blocker One', ntrp: 3.0 })
    const blockA = await hostAtLarragoite(page, 12, 3.0)
    await fillGame(page, blockA, 'Block Filler A', 3.0)

    await page.getByRole('button', { name: 'Sign out' }).click()
    await signIn(page, uniqueEmail('multi-block-b'))
    await completeProfile(page, { name: 'Blocker Two', ntrp: 3.0 })
    const blockB = await hostAtLarragoite(page, 12, 3.0)
    await fillGame(page, blockB, 'Block Filler B', 3.0)

    // Now a host who *starts* at Larragoite has no court there at all, and
    // widens to another park instead.
    await page.getByRole('button', { name: 'Sign out' }).click()
    await signIn(page, uniqueEmail('multi-host'))
    await completeProfile(page, { name: 'Wanda Wide', ntrp: 3.0 })

    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Ron Shirley / Alto Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(12 * 60))
    await page.getByRole('button', { name: 'singles' }).click()

    // The whole point: other parks are on offer, and ticking one adds its
    // courts as fallbacks.
    const alsoTake = page.getByRole('checkbox', { name: /Salvador Perez Park/ })
    await expect(alsoTake).toBeVisible()
    await alsoTake.check()

    const seatSelects = page.locator('select[id^="level-"]')
    for (let i = 0; i < (await seatSelects.count()); i++) {
      // String(3.0) is "3" — the option values are numbers, not fixed-decimal
      // strings, so the literal '3.0' matches nothing.
      await seatSelects.nth(i).selectOption(String(3.0))
    }
    await expect(page.getByTestId('courts-loading')).toHaveCount(0)
    await expect.poll(() => page.getByLabel('Court', { exact: true }).inputValue()).toContain(
      'crt-alto-',
    )
    await page.getByRole('button', { name: 'Post game' }).click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)

    // Both parks appear in the shortlist the court will be chosen from.
    const options = page.getByTestId('court-options')
    await expect(options).toContainText('Ron Shirley / Alto Park')
    await expect(options).toContainText('Salvador Perez Park')
  })
})
