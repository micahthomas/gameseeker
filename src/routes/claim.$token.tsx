import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import { claimByToken, inspectClaimToken } from '~/fn/games'

/**
 * The landing page for a claim link out of a notification.
 *
 * It deliberately does NOT claim on page load: email clients and link
 * scanners prefetch URLs, which would silently commit somebody to a game they
 * never agreed to. Claiming takes a tap.
 */
export const Route = createFileRoute('/claim/$token')({
  loader: ({ params }) => inspectClaimToken({ data: { token: params.token } }),
  component: Claim,
})

function Claim() {
  const info = Route.useLoaderData()
  const { token } = Route.useParams()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!info) {
    return (
      <Shell title="This invitation has expired">
        <p className="hint">
          The link is no longer valid. The game may have been cancelled or already filled.
        </p>
        <Link to="/" className="btn-primary mt-6">
          See other open games
        </Link>
      </Shell>
    )
  }

  if (!info.signedIn) {
    return (
      <Shell title="Sign in to claim your spot">
        <p className="hint">
          We'll bring you right back here. Use the same email address the invitation was sent to.
        </p>
        <Link to="/login" className="btn-primary mt-6">
          Sign in
        </Link>
      </Shell>
    )
  }

  if (!info.isForViewer) {
    return (
      <Shell title="This invitation is for someone else">
        <p className="hint">
          It was sent to a different player's email address. You can still browse open games that
          match your level.
        </p>
        <Link to="/" className="btn-primary mt-6">
          Find a game
        </Link>
      </Shell>
    )
  }

  if (info.status === 'cancelled') {
    return (
      <Shell title="That game was cancelled">
        <Link to="/" className="btn-primary mt-6">
          Find another game
        </Link>
      </Shell>
    )
  }

  if (info.openSlots === 0) {
    return (
      <Shell title="That spot is taken">
        <p className="hint">
          Someone confirmed first. It happens — here's what else is open at your level.
        </p>
        <Link to="/" className="btn-primary mt-6">
          See open games
        </Link>
      </Shell>
    )
  }

  async function handleClaim() {
    setError(null)
    setBusy(true)
    try {
      const result = await claimByToken({ data: { token } })
      if (!result.ok) {
        setError(result.reason)
        return
      }
      await router.invalidate()
      router.navigate({ to: '/games/$gameId', params: { gameId: result.gameId } })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell title="Claim your spot">
      <p className="hint">
        {info.openSlots} spot{info.openSlots === 1 ? '' : 's'} still open. First to confirm plays.
      </p>
      <FormError message={error} />
      <button className="btn-primary mt-6 w-full" disabled={busy} onClick={handleClaim}>
        {busy ? 'Claiming…' : "I'm in"}
      </button>
      <Link
        to="/games/$gameId"
        params={{ gameId: info.gameId }}
        className="btn-secondary mt-2 w-full"
      >
        See the details first
      </Link>
    </Shell>
  )
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-sm py-12 text-center">
      <p className="text-4xl">🎾</p>
      <h1 className="mt-4 text-xl font-bold">{title}</h1>
      <div className="mt-2">{children}</div>
    </div>
  )
}
