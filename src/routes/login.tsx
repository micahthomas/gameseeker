import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import { requestLogin } from '~/fn/auth'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: '/' })
  },
  component: Login,
})

function Login() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [devLink, setDevLink] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setState('sending')
    try {
      const result = await requestLogin({ data: { email } })
      setDevLink(result.devLink ?? null)
      setState('sent')
    } catch (err) {
      setError(errorMessage(err))
      setState('idle')
    }
  }

  if (state === 'sent') {
    return (
      <div className="mx-auto max-w-sm py-10 text-center">
        <p className="text-4xl">📬</p>
        <h1 className="mt-4 text-xl font-bold">Check your email</h1>
        <p className="hint mt-2">
          We sent a sign-in link to <strong>{email}</strong>. It works once and expires in 15
          minutes.
        </p>

        {devLink ? (
          <div className="card mt-6 p-4 text-left">
            <p className="text-xs font-semibold tracking-wide text-clay-600 uppercase">
              Development mode
            </p>
            <p className="hint mt-1">
              No email provider is configured, so here's the link directly:
            </p>
            <a href={devLink} className="mt-2 block break-all text-sm text-pinon-600 underline">
              {devLink}
            </a>
          </div>
        ) : null}

        <button className="btn-secondary mt-6" onClick={() => setState('idle')}>
          Use a different email
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-sm py-10">
      <h1 className="text-2xl font-bold">Sign in</h1>
      <p className="hint mt-2">
        No password. Enter your email and we'll send you a link. New here? This creates your
        account.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            className="input"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <FormError message={error} />

        <button type="submit" className="btn-primary w-full" disabled={state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Email me a link'}
        </button>
      </form>
    </div>
  )
}
