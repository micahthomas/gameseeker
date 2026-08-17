import { expect, test } from '@playwright/test'
import { goto } from './helpers'

/**
 * The icons and the manifest are plain files in `public/`, served as the
 * Worker's static assets rather than by any route. Nothing else in the suite
 * would notice if that wiring broke — the app renders fine without a favicon —
 * so the requests are made here directly.
 */
test.describe('site chrome', () => {
  test('serves every icon the document asks for', async ({ page, request }) => {
    await goto(page, '/')

    const hrefs = await page
      .locator('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')
      .evaluateAll((links) => links.map((l) => l.getAttribute('href')!))

    expect(hrefs).toEqual(
      expect.arrayContaining([
        '/favicon.ico',
        '/favicon.svg',
        '/apple-touch-icon.png',
        '/site.webmanifest',
      ]),
    )

    for (const href of hrefs) {
      const response = await request.get(href)
      expect(response.status(), `${href} should be served`).toBe(200)
      expect(Number(response.headers()['content-length'] ?? 1), href).toBeGreaterThan(0)
    }
  })

  test('the manifest names the app and points at icons that exist', async ({ request }) => {
    const manifest = await (await request.get('/site.webmanifest')).json()

    expect(manifest.name).toContain('GameSeeker')
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      expect((await request.get(icon.src)).status(), icon.src).toBe(200)
    }
  })

  test('the footer offers a way to support the project @mobile', async ({ page }) => {
    // Signed out: the support page is for anyone who lands on the site.
    await goto(page, '/')

    await page.getByRole('link', { name: 'Support GameSeeker' }).click()
    await expect(page).toHaveURL(/\/support/)

    const donate = page.getByRole('link', { name: 'Donate on Ko-fi' })
    await expect(donate).toBeVisible()
    await expect(donate).toHaveAttribute('href', 'https://ko-fi.com/micahthomas')

    // The costs are the reason the page exists, so say what they are.
    await expect(page.getByRole('heading', { name: 'What it actually costs' })).toBeVisible()
  })
})
