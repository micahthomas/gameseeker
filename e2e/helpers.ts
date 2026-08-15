import { expect, type Page } from '@playwright/test'

/**
 * Navigate and wait for React to hydrate.
 *
 * The app is server-rendered, so the HTML arrives before its event handlers
 * do. Clicking in that window submits forms natively and silently does
 * nothing useful, which is a maddening source of flakes. The root component
 * sets data-hydrated once React has mounted.
 */
export async function goto(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.waitForSelector('html[data-hydrated="true"]', { timeout: 15_000 })
}

/** Unique per run so tests never collide on the shared local database. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@santafe.test`
}

/**
 * Sign in by magic link, exactly as a player would.
 *
 * In development the console mail adapter renders the link on the page instead
 * of sending it, so there's no inbox to poll — the test clicks the same link
 * that would have arrived by email.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await goto(page, '/login')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a link' }).click()

  await expect(page.getByText('Check your email')).toBeVisible()
  const link = page.getByRole('link', { name: /\/auth\/verify\?token=/ })
  await expect(link).toBeVisible()
  await link.click()
}

export type ProfileOptions = {
  name: string
  ntrp?: number
  /** Levels to end up selected. Defaults to just their own level. */
  playLevels?: number[]
  phone?: string
  singles?: boolean
  doubles?: boolean
  gender?: 'woman' | 'man' | 'nonbinary'
  mixed?: boolean
}

/** Fill in the profile form a new player is forced through on first sign-in. */
export async function completeProfile(page: Page, options: ProfileOptions): Promise<void> {
  const ntrp = options.ntrp ?? 3.5
  await page.waitForURL(/\/profile/)
  await page.waitForSelector('html[data-hydrated="true"]')

  await page.getByLabel('Name').fill(options.name)
  if (options.phone) await page.getByLabel(/^Phone/).fill(options.phone)
  await page.getByLabel('Your NTRP').selectOption(String(ntrp))

  await setPlayLevels(page, options.playLevels ?? [ntrp])

  if (options.gender) {
    await page.getByLabel(/^Gender/).selectOption(options.gender)
  }
  if (options.singles === false) await page.getByLabel('Singles').uncheck()
  if (options.doubles === false) await page.getByLabel('Doubles').uncheck()
  if (options.mixed === false) await page.getByLabel('Mixed doubles').uncheck()

  await page.getByRole('button', { name: /^Save/ }).click()

  // Saving a first-time profile redirects to /availability. Waiting for that
  // to land keeps callers from navigating into a pending transition.
  await page.waitForURL(/\/availability/)
  await page.waitForSelector('html[data-hydrated="true"]')
}

/** Toggle the level chips until exactly `wanted` are pressed. */
export async function setPlayLevels(page: Page, wanted: number[]): Promise<void> {
  const targets = wanted.map((n) => n.toFixed(1))
  const chips = page.getByRole('button', { name: /^\d\.\d$/ })
  const count = await chips.count()

  for (let i = 0; i < count; i++) {
    const chip = chips.nth(i)
    const label = (await chip.textContent())?.trim() ?? ''
    const shouldBeOn = targets.includes(label)
    const isOn = (await chip.getAttribute('aria-pressed')) === 'true'
    if (shouldBeOn !== isOn) await chip.click()
  }
}

/** Column index for a weekday (0 = Sunday) in a Monday-first week. */
export function columnFor(weekday: number): number {
  return (weekday + 6) % 7
}

/**
 * Drag on the availability calendar to paint a block of time.
 *
 * `weekday` is 0 = Sunday. `fromHour`/`toHour` are Santa Fe wall-clock hours
 * within the 6am-10pm grid.
 *
 * Targets the half-hour cells by their data-slot attribute rather than
 * computing pixel offsets: Playwright then scrolls each one into view and
 * waits for it to stop moving, which pixel math cannot do.
 */
export async function dragAvailability(
  page: Page,
  weekday: number,
  fromHour: number,
  toHour: number,
): Promise<void> {
  const column = columnFor(weekday)
  const first = page.locator(`[data-slot="${column}:${fromHour * 60}"]`)
  // The end hour is exclusive, so grab the last half-hour cell inside it.
  const last = page.locator(`[data-slot="${column}:${toHour * 60 - 30}"]`)

  await first.hover()
  await page.mouse.down()
  await last.hover()
  await page.mouse.up()
}

/** The next occurrence of `weekday` (0 = Sunday) at least `minDays` out. */
export function nextWeekdayDate(weekday: number, minDays = 2): Date {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + minDays)
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1)
  return d
}

export function toDateInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Drag on a location's court grid to select a slot to host in.
 * `column` is the zero-based court column; hours are Santa Fe wall clock.
 */
export async function dragCourt(
  page: Page,
  column: number,
  fromHour: number,
  toHour: number,
): Promise<void> {
  const grid = page.getByRole('application', { name: /Court schedule/ })
  await expect(grid).toBeVisible()
  const first = grid.locator(`[data-slot="${column}:${fromHour * 60}"]`)
  const last = grid.locator(`[data-slot="${column}:${toHour * 60 - 30}"]`)

  await first.hover()
  await page.mouse.down()
  await last.hover()
  await page.mouse.up()
}
