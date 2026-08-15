import { Link } from '@tanstack/react-router'

export function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      <p className="text-5xl">🎾</p>
      <h1 className="mt-4 text-2xl font-bold">Out of bounds</h1>
      <p className="hint mt-2">We couldn't find that page.</p>
      <Link to="/" className="btn-primary mt-6">
        Back to the dashboard
      </Link>
    </div>
  )
}
