/// <reference types="vite/client" />
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useEffect } from 'react'
import type * as React from 'react'
import { ErrorPanel } from '~/components/ErrorPanel'
import { NotFound } from '~/components/NotFound'
import { InboxBell } from '~/components/InboxBell'
import { fetchMe, logout } from '~/fn/auth'
import appCss from '~/styles/app.css?url'

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    const user = await fetchMe()

    // A player who signed in but never filled out name and rating can't be
    // matched to anything, so finish that before letting them loose.
    if (
      user &&
      user.profileCompletedAt === null &&
      !location.pathname.startsWith('/profile') &&
      !location.pathname.startsWith('/auth') &&
      // Linked from the footer of every page, including /profile itself, so
      // bouncing them back would make it look broken.
      location.pathname !== '/support'
    ) {
      throw redirect({ to: '/profile', search: { welcome: true } })
    }

    return { user }
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#2f5d3f' },
      { title: 'Santa Fe Tennis GameSeeker' },
      {
        name: 'description',
        content:
          'Find a tennis game in Santa Fe. Post your availability, host a match, and let the right players know.',
      },
    ],
    // Icons are files in public/, which the Cloudflare plugin serves from the
    // client build as the Worker's assets — no route and no import needed.
    // favicon.ico is listed for the browsers that ask for it by path anyway;
    // everything current takes the SVG and scales it.
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      { rel: 'manifest', href: '/site.webmanifest' },
    ],
  }),
  errorComponent: ({ error }) => <ErrorPanel error={error} />,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
})

/**
 * Flags that React has taken over the server-rendered HTML.
 *
 * Before this runs, buttons and forms are inert markup — a click submits the
 * form natively instead of calling its handler. Browser tests wait on this
 * attribute so they interact with a live page rather than racing hydration.
 */
function useHydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true'
  }, [])
}

function RootDocument({ children }: { children: React.ReactNode }) {
  useHydrationMarker()

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="min-h-dvh flex flex-col">
          <SiteHeader />
          <main className="flex-1 w-full mx-auto max-w-3xl px-4 py-6">{children}</main>
          <SiteFooter />
        </div>
        <Scripts />
      </body>
    </html>
  )
}

function SiteHeader() {
  const { user } = Route.useRouteContext()
  const router = useRouter()

  async function handleLogout() {
    await logout()
    await router.invalidate()
    router.navigate({ to: '/' })
  }

  return (
    <header className="border-b border-sand-200 bg-white">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <Link to="/" className="flex items-center gap-2 font-bold tracking-tight">
          <span aria-hidden>🎾</span>
          <span>
            <span className="text-pinon-600">Santa Fe</span> GameSeeker
          </span>
        </Link>

        <div className="ml-auto flex items-center gap-1 text-sm">
          {user ? (
            <>
              {/* Mounted here, in the layout, so the socket lives for the
                  whole session rather than being torn down on navigation. */}
              <InboxBell />
              <Link
                to="/games/new"
                className="hidden sm:inline-flex btn-primary !px-3 !py-1.5 !text-sm"
              >
                Host a game
              </Link>
              <button onClick={handleLogout} className="btn-secondary !px-3 !py-1.5 !text-sm">
                Sign out
              </button>
            </>
          ) : (
            <Link to="/login" className="btn-primary !px-3 !py-1.5 !text-sm">
              Sign in
            </Link>
          )}
        </div>
      </div>

      {user ? (
        <nav className="mx-auto max-w-3xl overflow-x-auto px-4">
          <ul className="flex gap-1 pb-2 text-sm font-semibold whitespace-nowrap">
            <NavItem to="/">Games</NavItem>
            <NavItem to="/availability">My times</NavItem>
            <NavItem to="/locations">Courts</NavItem>
            <NavItem to="/clinics">Clinics</NavItem>
            <NavItem to="/profile">Profile</NavItem>
            {user.isAdmin ? <NavItem to="/admin">Admin</NavItem> : null}
          </ul>
        </nav>
      ) : null}
    </header>
  )
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <li>
      <Link
        to={to}
        activeOptions={{ exact: to === '/' }}
        className="block rounded-lg px-3 py-1.5 text-ink-soft hover:bg-sand-100"
        activeProps={{ className: '!bg-pinon-50 !text-pinon-700' }}
      >
        {children}
      </Link>
    </li>
  )
}

function SiteFooter() {
  return (
    <footer className="border-t border-sand-200 px-4 py-6 text-center text-xs text-ink-soft">
      <p>
        Court times here are agreements between players, not reservations with the City of Santa Fe.
        Public park courts are first come, first served.
      </p>
      <p className="mt-3 flex items-center justify-center gap-3">
        <Link to="/support" className="font-semibold text-pinon-600 hover:underline">
          Support GameSeeker
        </Link>
        <span aria-hidden className="text-sand-300">
          ·
        </span>
        <a
          href="https://github.com/micahthomas/gameseeker"
          className="hover:underline"
          target="_blank"
          rel="noreferrer"
        >
          Source
        </a>
      </p>
    </footer>
  )
}
