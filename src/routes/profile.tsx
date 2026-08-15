import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import type { RatingSystem } from '~/db/schema'
import { fetchLocations } from '~/fn/games'
import { saveProfile } from '~/fn/profile'
import { NTRP_DESCRIPTIONS, NTRP_LEVELS, utrToNtrp } from '~/server/rating'

export const Route = createFileRoute('/profile')({
  validateSearch: z.object({ welcome: z.boolean().optional() }),
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
    return { user: context.user }
  },
  loader: () => fetchLocations(),
  component: Profile,
})

function Profile() {
  const { user } = Route.useRouteContext()
  const locations = Route.useLoaderData()
  const { welcome } = Route.useSearch()
  const router = useRouter()

  const [name, setName] = useState(user.profileCompletedAt ? user.name : '')
  const [phone, setPhone] = useState(user.phone ?? '')
  const [ratingSystem, setRatingSystem] = useState<RatingSystem>(user.ratingSystem)
  const [ratingValue, setRatingValue] = useState(String(user.ratingValue))
  const [playsSingles, setPlaysSingles] = useState(user.playsSingles)
  const [playsDoubles, setPlaysDoubles] = useState(user.playsDoubles)
  const [notifyEmail, setNotifyEmail] = useState(user.notifyEmail)
  const [notifySms, setNotifySms] = useState(user.notifySms)
  const [homeLocationId, setHomeLocationId] = useState(user.homeLocationId ?? '')

  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const numericRating = Number(ratingValue)
  const equivalentNtrp =
    ratingSystem === 'UTR' && Number.isFinite(numericRating) ? utrToNtrp(numericRating) : null

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await saveProfile({
        data: {
          name,
          phone: phone || undefined,
          ratingSystem,
          ratingValue: numericRating,
          playsSingles,
          playsDoubles,
          notifyEmail,
          notifySms,
          homeLocationId: homeLocationId || null,
        },
      })
      setSaved(true)
      await router.invalidate()
      if (welcome) router.navigate({ to: '/availability' })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-bold">{welcome ? 'Welcome — tell us about your game' : 'Your profile'}</h1>
      {welcome ? (
        <p className="hint mt-2">
          Your rating and formats decide which games you hear about, so it's worth getting right.
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-6 space-y-6">
        <section className="card space-y-4 p-4">
          <div>
            <label className="label" htmlFor="name">
              Name
            </label>
            <input
              id="name"
              className="input"
              required
              placeholder="How you'll show up to other players"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="phone">
              Phone <span className="font-normal text-ink-soft">(optional)</span>
            </label>
            <input
              id="phone"
              type="tel"
              className="input"
              placeholder="505-555-0123"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <p className="hint mt-1">
              Shared only with players in a game you've both joined, so you can coordinate.
            </p>
          </div>
        </section>

        <section className="card space-y-4 p-4">
          <div>
            <span className="label">Rating system</span>
            <div className="flex gap-2">
              {(['NTRP', 'UTR'] as const).map((system) => (
                <button
                  key={system}
                  type="button"
                  onClick={() => {
                    setRatingSystem(system)
                    setRatingValue(system === 'NTRP' ? '3.5' : '5.0')
                  }}
                  className={
                    ratingSystem === system
                      ? 'btn-primary flex-1 !py-2'
                      : 'btn-secondary flex-1 !py-2'
                  }
                >
                  {system}
                </button>
              ))}
            </div>
            <p className="hint mt-2">
              Everyone is matched on one NTRP scale; UTR ratings are converted automatically.
            </p>
          </div>

          {ratingSystem === 'NTRP' ? (
            <div>
              <label className="label" htmlFor="ntrp">
                Your NTRP
              </label>
              <select
                id="ntrp"
                className="input"
                value={ratingValue}
                onChange={(e) => setRatingValue(e.target.value)}
              >
                {NTRP_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level.toFixed(1)}
                  </option>
                ))}
              </select>
              <p className="hint mt-1">{NTRP_DESCRIPTIONS[Number(ratingValue).toFixed(1)]}</p>
            </div>
          ) : (
            <div>
              <label className="label" htmlFor="utr">
                Your UTR
              </label>
              <input
                id="utr"
                type="number"
                step="0.01"
                min="1"
                max="16.5"
                className="input"
                value={ratingValue}
                onChange={(e) => setRatingValue(e.target.value)}
              />
              {equivalentNtrp ? (
                <p className="hint mt-1">
                  Matches you with roughly <strong>{equivalentNtrp.toFixed(1)} NTRP</strong>{' '}
                  players.
                </p>
              ) : null}
            </div>
          )}

          <div>
            <span className="label">What do you play?</span>
            <div className="space-y-2">
              <Check label="Singles" checked={playsSingles} onChange={setPlaysSingles} />
              <Check label="Doubles" checked={playsDoubles} onChange={setPlaysDoubles} />
            </div>
          </div>
        </section>

        <section className="card space-y-4 p-4">
          <div>
            <span className="label">How should we reach you?</span>
            <div className="space-y-2">
              <Check
                label={`Email (${user.email})`}
                checked={notifyEmail}
                onChange={setNotifyEmail}
              />
              <Check
                label="Text message"
                checked={notifySms}
                onChange={setNotifySms}
                disabled={!phone}
                hint={phone ? undefined : 'Add a phone number first'}
              />
            </div>
            <p className="hint mt-2">
              We message you when a game matches your level and one of your available times.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="home">
              Home courts <span className="font-normal text-ink-soft">(optional)</span>
            </label>
            <select
              id="home"
              className="input"
              value={homeLocationId}
              onChange={(e) => setHomeLocationId(e.target.value)}
            >
              <option value="">No preference</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
          </div>
        </section>

        <FormError message={error} />

        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : welcome ? 'Save and set my times' : 'Save profile'}
          </button>
          {saved && !welcome ? <span className="hint">Saved.</span> : null}
        </div>
      </form>
    </div>
  )
}

function Check({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  hint?: string
}) {
  return (
    <label className={`flex items-start gap-2.5 ${disabled ? 'opacity-50' : ''}`}>
      <input
        type="checkbox"
        className="mt-0.5 size-5 accent-pinon-600"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint ? <span className="hint block">{hint}</span> : null}
      </span>
    </label>
  )
}
