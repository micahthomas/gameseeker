import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { verifyMagicLink } from '~/fn/auth'

export const Route = createFileRoute('/auth/verify')({
  validateSearch: z.object({ token: z.string().optional() }),
  component: Verify,
})

function Verify() {
  const { token } = Route.useSearch()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const attempted = useRef(false)

  useEffect(() => {
    // Redeeming is a one-shot side effect; React 18+ dev double-invokes
    // effects, and a second call would consume an already-spent token and
    // report failure on a perfectly good sign-in.
    if (attempted.current) return
    attempted.current = true

    if (!token) {
      setError('That link is missing its token.')
      return
    }

    void (async () => {
      try {
        const result = await verifyMagicLink({ data: { token } })
        if (!result.ok) {
          setError(result.reason)
          return
        }
        await router.invalidate()
        router.navigate(
          result.needsProfile ? { to: '/profile', search: { welcome: true } } : { to: '/' },
        )
      } catch {
        setError('We couldn’t sign you in. Try requesting a new link.')
      }
    })()
  }, [token, router])

  if (error) {
    return (
      <div className="mx-auto max-w-sm py-16 text-center">
        <h1 className="text-xl font-bold">Sign-in link didn't work</h1>
        <p className="hint mt-2">{error}</p>
        <Link to="/login" className="btn-primary mt-6">
          Request a new link
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-sm py-16 text-center">
      <p className="hint">Signing you in…</p>
    </div>
  )
}
