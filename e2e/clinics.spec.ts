import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { completeProfile, goto, nextWeekdayDate, signIn, toDateInputValue, uniqueEmail } from './helpers'

/**
 * The whole clinic path, end to end: ask to run one, be approved, set it up,
 * publish it, and have someone sign up.
 *
 * Clinics book **Atalaya Park**, which no other spec touches — a clinic holds
 * its court for every date in the series, so sharing a park with the games
 * specs would take courts out from under them for weeks at a time. Hours are
 * still spaced apart within this file for the same reason they are in
 * games.spec.ts: the suite shares one database.
 */

const ATALAYA = 'Atalaya Park'
const TUESDAY = 2

/** The smallest valid PNG, for exercising the upload path for real. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function promoteToAdmin(email: string) {
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'gameseeker-test',
      '--local',
      '--env',
      'test',
      `--command=UPDATE users SET is_admin = 1 WHERE email = '${email}'`,
    ],
    { stdio: 'pipe' },
  )
}

/** Set up a clinic on the next Tuesday at `hour`, for a single date. */
async function createClinic(
  page: Page,
  options: {
    title: string
    hour: number
    capacity?: number
    description?: string
    hero?: boolean
  },
) {
  await goto(page, '/clinics/new')

  await page.getByLabel('What is it?').fill(options.title)
  await page.getByLabel('Where', { exact: true }).selectOption({ label: ATALAYA })
  await page.getByRole('button', { name: 'Tue', exact: true }).click()
  await page.getByLabel('From', { exact: true }).selectOption(String(options.hour * 60))
  await page.getByLabel('To', { exact: true }).selectOption(String((options.hour + 1) * 60))

  // A one-week window, so the series is a single date and can't collide with
  // another test's hour on a later Tuesday.
  const first = nextWeekdayDate(TUESDAY)
  await page.getByLabel('Starting', { exact: true }).fill(toDateInputValue(first))
  await page.getByLabel('Until', { exact: true }).fill(toDateInputValue(first))

  if (options.description) {
    await page.getByLabel('Description', { exact: true }).fill(options.description)
  }
  if (options.capacity !== undefined) {
    await page.getByLabel('Places per session').fill(String(options.capacity))
  }
  if (options.hero) {
    // A real 1x1 PNG: the upload handler sniffs the leading bytes rather than
    // trusting the declared type, so anything else is refused.
    await page.getByLabel('Photo (optional)').setInputFiles({
      name: 'hero.png',
      mimeType: 'image/png',
      buffer: ONE_PIXEL_PNG,
    })
    // The preview only renders once R2 has the object and handed back a key.
    await expect(page.locator('img[src^="/api/media/clinics/"]')).toBeVisible()
  }

  // The court list depends on every date of the series, so it is refetched
  // whenever the series changes — wait for it rather than racing it.
  await expect(page.getByTestId('courts-loading')).toHaveCount(0)
  const courts = page.getByTestId('clinic-courts')
  await courts.selectOption({ index: 1 })
  // Which court it took, so a caller can assert it is now off the market.
  const courtName = (await courts.locator('option:checked').textContent())?.trim() ?? ''

  await page.getByRole('button', { name: 'Create clinic' }).click()
  await page.waitForURL(/\/clinics\/[0-9a-f-]{36}\/manage/)
  return courtName
}

test.describe('running a clinic', () => {
  test('a player asks to run clinics and an admin approves it', async ({ page }) => {
    const email = uniqueEmail('organizer')
    await signIn(page, email)
    await completeProfile(page, { name: 'Olive Organizer', ntrp: 4.0 })

    await goto(page, '/profile')
    await page.getByLabel('What would you run?').fill('Tuesday cardio tennis at Atalaya.')
    await page.getByRole('button', { name: 'Ask to run clinics' }).click()
    await expect(page.getByText(/request to run clinics is with an admin/)).toBeVisible()

    // Nothing has been granted yet, so the create form stays out of reach.
    await goto(page, '/clinics/new')
    await expect(page).toHaveURL(/\/profile/)

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()

    const adminEmail = uniqueEmail('clinicadmin')
    await signIn(page, adminEmail)
    await completeProfile(page, { name: 'Ada Admin', ntrp: 4.0 })
    promoteToAdmin(adminEmail)

    await goto(page, '/admin')
    await page.getByRole('button', { name: /Organizers/ }).click()
    const request = page
      .getByTestId('organizer-requests')
      .locator('li')
      .filter({ hasText: 'Olive Organizer' })
    await expect(request.getByText('Tuesday cardio tennis at Atalaya.')).toBeVisible()
    await request.getByRole('button', { name: 'Approve' }).click()
    // The Approve button is only rendered while the request is undecided, so
    // its disappearance is a stronger signal than the status chip's text.
    await expect(request.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await expect(request.getByRole('button', { name: 'Revoke' })).toBeVisible()

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()

    await signIn(page, email)
    // A returning player lands on the dashboard. Waiting for that is what
    // makes the session real before the next navigation, rather than racing
    // the verify request.
    await page.waitForURL('/')

    await goto(page, '/profile')
    await expect(page.getByText('You can set up clinics and take signups')).toBeVisible()
  })

  test('an organizer sets one up, publishes it, and a player takes a place', async ({ page }) => {
    const organizer = uniqueEmail('coach')
    await signIn(page, organizer)
    await completeProfile(page, { name: 'Cody Coach', ntrp: 4.5 })
    promoteToAdmin(organizer) // an admin is an organizer implicitly

    await createClinic(page, {
      title: 'Cardio Tennis',
      hour: 7,
      capacity: 1,
      description: '## What to expect\n\nAn hour of drills. Bring **water**.',
      hero: true,
    })
    const manageUrl = page.url()
    const clinicUrl = manageUrl.replace('/manage', '')

    // Created but not published: the courts are held, the world isn't told.
    await expect(page.getByText('Not published yet')).toBeVisible()
    await page.getByTestId('publish-clinic').click()
    await expect(page.getByTestId('publish-clinic')).toHaveCount(0)

    await goto(page, clinicUrl)
    // Markdown is rendered, and rendered as markup rather than printed.
    // The uploaded image is served back from the Worker, not hotlinked.
    const hero = page.locator('img[src^="/api/media/clinics/"]')
    await expect(hero).toBeVisible()
    const heroResponse = await page.request.get((await hero.getAttribute('src'))!)
    expect(heroResponse.headers()['content-type']).toBe('image/png')
    expect(heroResponse.headers()['cache-control']).toContain('immutable')

    const description = page.getByTestId('clinic-description')
    await expect(description.getByRole('heading', { name: 'What to expect' })).toBeVisible()
    await expect(description.locator('strong')).toHaveText('water')

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()

    // A player signs up, and fills the one place.
    await signIn(page, uniqueEmail('joiner'))
    await completeProfile(page, { name: 'Perry Player', ntrp: 3.5 })
    await goto(page, clinicUrl)

    const session = page.getByTestId('clinic-sessions').locator('li').first()
    await expect(session.getByText('1 of 1 left')).toBeVisible()
    await session.getByRole('button', { name: 'Sign up' }).click()
    await expect(session.getByText('Full')).toBeVisible()
    await expect(session.getByRole('button', { name: "I'm out" })).toBeVisible()

    // And it shows up where they'd look for it.
    await goto(page, '/')
    await expect(page.getByTestId('my-clinics').getByText('Cardio Tennis')).toBeVisible()

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()

    // A second player finds it full.
    await signIn(page, uniqueEmail('late'))
    await completeProfile(page, { name: 'Lana Late', ntrp: 3.5 })
    await goto(page, clinicUrl)

    const full = page.getByTestId('clinic-sessions').locator('li').first()
    await expect(full.getByRole('button', { name: 'Full' })).toBeDisabled()
  })

  test('a clinic holds its court on the day view, and a game cannot take it', async ({ page }) => {
    const organizer = uniqueEmail('holder')
    await signIn(page, organizer)
    await completeProfile(page, { name: 'Holly Holder', ntrp: 4.0 })
    promoteToAdmin(organizer)

    const clinicCourt = await createClinic(page, { title: 'Junior Drills', hour: 9 })
    await page.getByTestId('publish-clinic').click()

    // It draws solid on the day view, because it holds the court outright —
    // unlike a game, which draws in outline until it has actually taken one.
    const tuesday = nextWeekdayDate(TUESDAY)
    await goto(page, `/locations/loc-atalaya?day=${toDateInputValue(tuesday)}`)
    await expect(
      page.getByTestId('court-clinic').filter({ hasText: 'Junior Drills' }),
    ).toHaveCount(1)

    // And a host offering courts for the same hour is not offered that one:
    // games and clinics are settled by the same lock table.
    await goto(page, '/games/new')
    await page.getByLabel('Location').selectOption({ label: ATALAYA })
    await page.getByLabel('Date').fill(toDateInputValue(tuesday))
    await page.getByLabel('Start').selectOption(String(9 * 60))
    await expect(page.getByTestId('courts-loading')).toHaveCount(0)

    const offered = await page
      .getByLabel('Court', { exact: true })
      .locator('option')
      .allTextContents()
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.map((name) => name.trim())).not.toContain(clinicCourt)
  })
})
