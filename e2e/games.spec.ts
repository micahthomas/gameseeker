import { expect, test, type Page } from '@playwright/test'
import {
  completeProfile,
  dragAvailability,
  goto,
  nextWeekdayDate,
  signIn,
  toDateInputValue,
  uniqueEmail,
} from './helpers'

const WEDNESDAY = 3

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
  await expect.poll(() => page.getByLabel('Court').inputValue()).toContain(courtPrefix)
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

  test('the same court and time cannot be booked twice', async ({ page }) => {
    await signIn(page, uniqueEmail('first'))
    await completeProfile(page, { name: 'First Host', ntrp: 4.0 })
    await hostGame(page, { hour: 8, level: 4.0 })

    const courtName = await page.locator('section').first().innerText()
    await page.getByRole('button', { name: 'Sign out' }).click()

    // A second host at the same time is only offered the remaining courts.
    await signIn(page, uniqueEmail('second'))
    await completeProfile(page, { name: 'Second Host', ntrp: 4.0 })
    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Salvador Perez Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(8 * 60))

    // One of the six courts is now held, and it is simply not on offer.
    await expect(page.getByText(/5 courts open/)).toBeVisible()
    const options = await page.getByLabel('Court').locator('option').allTextContents()
    expect(options).toHaveLength(5)
    expect(courtName).toContain('Salvador Perez Park')
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
    await expect(page.getByText(/6 courts open/)).toBeVisible()
  })

  test('a doubles game opens three seats @mobile', async ({ page }) => {
    await signIn(page, uniqueEmail('doubles'))
    await completeProfile(page, { name: 'Dub Bles', ntrp: 3.5 })
    await hostGame(page, { hour: 6, format: 'doubles' })

    await expect(page.getByText(/3 spots open/)).toBeVisible()
    await expect(page.getByText('GameSeeker 3.5')).toHaveCount(3)
  })
})

test.describe('mixed doubles', () => {
  test('a mixed game holds seats to keep the teams even', async ({ page }) => {
    await signIn(page, uniqueEmail('mixed-host'))
    await completeProfile(page, { name: 'Manny Mixed', ntrp: 3.5, gender: 'man' })

    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: 'Salvador Perez Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(16 * 60))
    await page.getByRole('button', { name: 'doubles' }).click()
    await page.getByLabel('Mixed doubles').check()

    // A man hosting means two women's seats and one man's.
    await expect(page.getByText(/are a woman will be messaged/)).toHaveCount(2)
    await expect(page.getByText(/are a man will be messaged/)).toHaveCount(1)

    await page.getByRole('button', { name: 'Post game' }).click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    const gameUrl = page.url()

    await expect(page.getByText('Mixed doubles')).toBeVisible()
    await expect(page.getByText(/· a woman/)).toHaveCount(2)
    await page.getByRole('button', { name: 'Sign out' }).click()

    // A man cannot take a seat held for a woman.
    await signIn(page, uniqueEmail('mixed-man'))
    await completeProfile(page, { name: 'Other Man', ntrp: 3.5, gender: 'man' })
    await goto(page, gameUrl)
    await page.getByRole('button', { name: /claim a spot/i }).click()
    await expect(page.getByText(/· a man/)).toHaveCount(0)
    await page.getByRole('button', { name: 'Sign out' }).click()

    // A woman can.
    await signIn(page, uniqueEmail('mixed-woman'))
    await completeProfile(page, { name: 'Wanda Mixed', ntrp: 3.5, gender: 'woman' })
    await goto(page, gameUrl)
    await page.getByRole('button', { name: /claim a spot/i }).click()
    await expect(page.getByText('Wanda Mixed')).toBeVisible()
  })

  test('a player who opted out of mixed is not offered the game', async ({ page }) => {
    await signIn(page, uniqueEmail('mixed-host2'))
    await completeProfile(page, { name: 'Hosty Mixed', ntrp: 4.0, gender: 'woman' })

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
    await completeProfile(page, { name: 'Nomi Mixed', ntrp: 4.0, gender: 'man', mixed: false })
    await goto(page, gameUrl)
    await expect(page.getByRole('button', { name: /claim a spot/i })).toBeHidden()
  })

  test('the mixed option follows the chosen format', async ({ page }) => {
    await signIn(page, uniqueEmail('mixed-toggle'))
    await completeProfile(page, { name: 'Toggle Tess', ntrp: 3.0, gender: 'woman' })
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
  test('a mixed singles game holds its one seat for the opposite gender', async ({ page }) => {
    await signIn(page, uniqueEmail('ms-host'))
    await completeProfile(page, { name: 'Mona Single', ntrp: 3.5, gender: 'woman' })

    await goto(page, '/games/new')
    // A different park, because Salvador Perez's Wednesday is fully booked by
    // the other specs and court holds are global to this shared database.
    await page.getByLabel('Location').selectOption({ label: 'Herb Martinez / La Resolana Park' })
    await page.getByLabel('Date').fill(toDateInputValue(nextWeekdayDate(WEDNESDAY)))
    await page.getByLabel('Start').selectOption(String(13 * 60))
    await page.getByRole('button', { name: 'singles' }).click()
    await page.getByLabel('Mixed singles').check()

    // One seat, held for a man, because the host is a woman.
    await expect(page.getByText(/are a man will be messaged/)).toHaveCount(1)

    await page.getByRole('button', { name: 'Post game' }).click()
    await page.waitForURL(/\/games\/[0-9a-f-]{36}/)
    const gameUrl = page.url()
    await expect(page.getByText('Mixed singles')).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()

    // Another woman cannot take the seat held for a man.
    await signIn(page, uniqueEmail('ms-woman'))
    await completeProfile(page, { name: 'Wilma Single', ntrp: 3.5, gender: 'woman' })
    await goto(page, gameUrl)
    await expect(page.getByRole('button', { name: /claim a spot/i })).toBeHidden()
    await page.getByRole('button', { name: 'Sign out' }).click()

    // A man who opted into mixed singles can.
    await signIn(page, uniqueEmail('ms-man'))
    await completeProfile(page, { name: 'Marco Single', ntrp: 3.5, gender: 'man' })
    await goto(page, gameUrl)
    await page.getByRole('button', { name: /claim a spot/i }).click()
    await expect(page.getByText('Marco Single')).toBeVisible()
  })

  test('a player who did not opt into mixed singles is not offered the game', async ({ page }) => {
    await signIn(page, uniqueEmail('ms-host2'))
    await completeProfile(page, { name: 'Hana Single', ntrp: 4.5, gender: 'woman' })

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
      gender: 'man',
      mixedSingles: false,
    })
    await goto(page, gameUrl)
    await expect(page.getByRole('button', { name: /claim a spot/i })).toBeHidden()
  })
})
