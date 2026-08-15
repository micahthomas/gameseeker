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
import type * as React from 'react'
import { ErrorPanel } from '~/components/ErrorPanel'
import { NotFound } from '~/components/NotFound'
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
      !location.pathname.startsWith('/auth')
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
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  errorComponent: ({ error }) => <ErrorPanel error={error} />,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
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
    </footer>
  )
}
