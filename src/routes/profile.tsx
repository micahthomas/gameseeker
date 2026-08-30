import { Link, createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import {
  DIVISIONS,
  type Division,
  type OrganizerStatus,
  type PlayerFormat,
  type RatingSystem,
} from '~/db/schema'
import { fetchLocations } from '~/fn/games'
import { requestOrganizerAccess, saveProfile } from '~/fn/profile'
import { defaultFormats } from '~/server/formats'
import { NTRP_DESCRIPTIONS, NTRP_LEVELS, defaultPlayLevels, utrToNtrp } from '~/server/rating'

/**
 * Four independent opt-ins. Mixed is no longer nested under doubles: a player
 * can take mixed doubles without ordinary doubles, which the old
 * `plays_mixed`-implies-`plays_doubles` shape couldn't express.
 */
const FORMAT_CHOICES: Array<{ value: PlayerFormat; label: string; mixed: boolean }> = [
  { value: 'singles', label: 'Singles', mixed: false },
  { value: 'mixed_singles', label: 'Mixed singles', mixed: true },
  { value: 'doubles', label: 'Doubles', mixed: false },
  { value: 'mixed_doubles', label: 'Mixed doubles', mixed: true },
]

function locationName(locations: Array<{ id: string; name: string }>, id: string): string {
  return locations.find((loc) => loc.id === id)?.name ?? 'Unknown location'
}

/** Move the entry at `index` by `delta`, returning a new array. */
function move<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta
  if (target < 0 || target >= items.length) return items
  const next = [...items]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved!)
  return next
}

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
  // A profile created before this column existed, or any row that somehow has
  // an empty set, starts from the full four rather than from nothing — an
  // empty form would fail its own "pick at least one" rule on first save.
  const [formats, setFormats] = useState<PlayerFormat[]>(
    user.formats?.length ? user.formats : defaultFormats(),
  )
  const [division, setDivision] = useState<Division>(user.division)
  const [notifyEmail, setNotifyEmail] = useState(user.notifyEmail)
  const [notifySms, setNotifySms] = useState(user.notifySms)
  const [notifyClinics, setNotifyClinics] = useState(user.notifyClinics ?? true)
  const [preferredLocationIds, setPreferredLocationIds] = useState<string[]>(
    user.preferredLocationIds ?? [],
  )
  const [playLevels, setPlayLevels] = useState<number[]>(
    user.playLevels?.length ? user.playLevels : defaultPlayLevels(user.ntrp),
  )
  /**
   * Once a player has curated their level list we leave it alone. Before that,
   * changing your rating should move the suggested levels with it.
   */
  const [levelsTouched, setLevelsTouched] = useState(Boolean(user.profileCompletedAt))

  function updateRating(next: string, system: RatingSystem) {
    setRatingValue(next)
    if (levelsTouched) return
    const value = Number(next)
    if (!Number.isFinite(value)) return
    setPlayLevels(defaultPlayLevels(system === 'UTR' ? utrToNtrp(value) : value))
  }

  function toggleLevel(level: number) {
    setLevelsTouched(true)
    setPlayLevels((current) =>
      current.includes(level)
        ? current.filter((l) => l !== level)
        : [...current, level].sort((a, b) => a - b),
    )
  }

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
          notifyEmail,
          notifySms,
          notifyClinics,
          preferredLocationIds,
          playLevels,
          division,
          formats,
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
              Only used to text you about games. It is never shown to other players.
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
                    updateRating(system === 'NTRP' ? '3.5' : '5.0', system)
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
                onChange={(e) => updateRating(e.target.value, 'NTRP')}
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
                onChange={(e) => updateRating(e.target.value, 'UTR')}
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
            <span className="label">Levels you'll play</span>
            <p className="hint mb-2">
              You only hear about games asking for one of these. Pick more than one if you're happy
              to play up or down.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {NTRP_LEVELS.map((level) => {
                const selected = playLevels.includes(level)
                return (
                  <button
                    key={level}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleLevel(level)}
                    className={
                      selected
                        ? 'chip bg-pinon-600 text-white'
                        : 'chip bg-sand-100 text-sand-700 hover:bg-sand-200'
                    }
                  >
                    {level.toFixed(1)}
                  </button>
                )
              })}
            </div>
            {playLevels.length === 0 ? (
              <p className="hint mt-2 text-clay-600">
                Pick at least one level, or no game can reach you.
              </p>
            ) : null}
          </div>

          <div>
            <span className="label">What do you play?</span>
            <div className="space-y-2">
              {FORMAT_CHOICES.map((choice) => (
                <Check
                  key={choice.value}
                  label={choice.label}
                  checked={formats.includes(choice.value)}
                  onChange={(on) =>
                    setFormats((current) =>
                      on
                        ? [...current, choice.value]
                        : current.filter((f) => f !== choice.value),
                    )
                  }
                  hint={
                    choice.mixed && division === 'unspecified'
                      ? 'Set which you play below so hosts can balance the sides'
                      : undefined
                  }
                />
              ))}
            </div>
            {formats.length === 0 ? (
              <p className="hint mt-2 text-clay-600">
                Pick at least one, or no game can reach you.
              </p>
            ) : null}
          </div>

          <div>
            <label className="label" htmlFor="division">
              Which do you play? <span className="font-normal text-ink-soft">(optional)</span>
            </label>
            <select
              id="division"
              className="input"
              value={division}
              onChange={(e) => setDivision(e.target.value as Division)}
            >
              {DIVISIONS.map((option) => (
                <option key={option} value={option}>
                  {DIVISION_LABELS[option]}
                </option>
              ))}
            </select>
            <p className="hint mt-1">
              Used only to balance the two sides of a mixed game. Leave it unset and you'll still
              see singles and regular doubles — you just can't fill a seat that's held to one side
              to keep a mixed game even.
            </p>
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
            <span className="label">Clinics</span>
            <Check
              label="Tell me about new clinics"
              checked={notifyClinics}
              onChange={setNotifyClinics}
            />
            <p className="hint mt-2">
              Cardio tennis, drills and other coached sessions at the courts you prefer. A
              clinic isn't matched to your level or format the way a game is, so this is a
              separate switch.
            </p>
          </div>

          <div>
            <span className="label">
              Where you like to play{' '}
              <span className="font-normal text-ink-soft">(optional, in order)</span>
            </span>
            <p className="hint mb-2">
              Games at the courts nearest the top reach you first. Leaving this empty
              doesn't hide anything from you — you'll just hear about those games a
              little later.
            </p>

            {preferredLocationIds.length > 0 ? (
              <ol className="mb-2 space-y-2">
                {preferredLocationIds.map((id, index) => (
                  <li key={id} className="flex items-center gap-2">
                    <span className="w-5 text-sm text-ink-soft">{index + 1}.</span>
                    <span className="flex-1">{locationName(locations, id)}</span>
                    {/* Arrows rather than drag: keyboard- and screen-reader-
                        friendly, works on a phone at the court, and doesn't
                        pull in a drag library for a five-item list. */}
                    <button
                      type="button"
                      className="btn-secondary !px-2 !py-1 !text-sm"
                      aria-label={`Move ${locationName(locations, id)} up`}
                      disabled={index === 0}
                      onClick={() => setPreferredLocationIds((c) => move(c, index, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn-secondary !px-2 !py-1 !text-sm"
                      aria-label={`Move ${locationName(locations, id)} down`}
                      disabled={index === preferredLocationIds.length - 1}
                      onClick={() => setPreferredLocationIds((c) => move(c, index, 1))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn-secondary !px-2 !py-1 !text-sm"
                      aria-label={`Remove ${locationName(locations, id)}`}
                      onClick={() =>
                        setPreferredLocationIds((c) => c.filter((x) => x !== id))
                      }
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}

            <select
              id="add-location"
              aria-label="Add a preferred location"
              className="input"
              value=""
              onChange={(e) => {
                const id = e.target.value
                if (id) setPreferredLocationIds((c) => (c.includes(id) ? c : [...c, id]))
              }}
            >
              <option value="">Add a location…</option>
              {locations
                .filter((loc) => !preferredLocationIds.includes(loc.id))
                .map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
            </select>
          </div>
        </section>

        <FormError message={error} />

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="btn-primary"
            disabled={saving || playLevels.length === 0}
          >
            {saving ? 'Saving…' : welcome ? 'Save and set my times' : 'Save profile'}
          </button>
          {saved && !welcome ? <span className="hint">Saved.</span> : null}
        </div>
      </form>

      {/* Outside the profile form: a separate decision with its own submit,
          and nesting a second form inside the first is invalid HTML. */}
      {user.profileCompletedAt ? <OrganizerRequest status={user.organizerStatus} /> : null}
    </div>
  )
}

/**
 * Asking to run clinics.
 *
 * Not a checkbox on the profile because it isn't the player's to set: holding
 * a public court for eight weeks is granted by an admin, and the note is what
 * they decide on.
 */
function OrganizerRequest({ status }: { status: OrganizerStatus }) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (status === 'approved') {
    return (
      <section className="card mt-6 space-y-2 p-4">
        <h2 className="font-bold">Clinics</h2>
        <p className="hint">You can set up clinics and take signups for them.</p>
        <Link to="/clinics/new" className="btn-secondary inline-block text-sm">
          Set up a clinic
        </Link>
      </section>
    )
  }

  if (status === 'requested') {
    return (
      <section className="card mt-6 space-y-2 p-4">
        <h2 className="font-bold">Clinics</h2>
        <p className="hint">
          Your request to run clinics is with an admin. We'll email you either way.
        </p>
      </section>
    )
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await requestOrganizerAccess({ data: { note } })
      await router.invalidate()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card mt-6 space-y-3 p-4">
      <h2 className="font-bold">Want to run a clinic?</h2>
      <p className="hint">
        Cardio tennis, a drills hour, a junior session — a recurring booking on a court with
        a description and a signup list. A clinic holds its court for the whole series, so an
        admin approves these.
        {status === 'declined' ? ' Your last request wasn\u2019t approved.' : ''}
      </p>
      <label className="label" htmlFor="organizer-note">
        What would you run?
      </label>
      <textarea
        id="organizer-note"
        className="input"
        rows={3}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Tuesday cardio tennis at Alto Park, 6-7pm, up to 8 players."
      />
      <FormError message={error} />
      <button type="submit" className="btn-secondary" disabled={busy || status === 'declined'}>
        {busy ? 'Sending…' : 'Ask to run clinics'}
      </button>
    </form>
  )
}

const DIVISION_LABELS: Record<Division, string> = {
  unspecified: 'Not set',
  womens: "Women's tennis",
  mens: "Men's tennis",
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
