import { Link } from '@tanstack/react-router'

/**
 * Server functions surface validation failures as thrown Errors. The message
 * on our own thrown errors is written for players, so show it directly rather
 * than replacing it with something generic.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === 'UNAUTHENTICATED') return 'Please sign in to continue.'
    if (error.message === 'FORBIDDEN') return "You don't have access to that."
    return error.message
  }
  return 'Something went wrong.'
}

export function ErrorPanel({ error }: { error: unknown }) {
  const message = errorMessage(error)
  const needsAuth = error instanceof Error && error.message === 'UNAUTHENTICATED'

  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-xl font-bold">{needsAuth ? 'Sign in required' : 'Something went wrong'}</h1>
      <p className="hint mt-2">{message}</p>
      {needsAuth ? (
        <Link to="/login" className="btn-primary mt-6">
          Sign in
        </Link>
      ) : (
        <Link to="/" className="btn-secondary mt-6">
          Back to the dashboard
        </Link>
      )}
    </div>
  )
}

/** Inline form-level error. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p
      role="alert"
      className="rounded-lg border border-clay-500/40 bg-clay-100 px-3 py-2 text-sm text-clay-600"
    >
      {message}
    </p>
  )
}
