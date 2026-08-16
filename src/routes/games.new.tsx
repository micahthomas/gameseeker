import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import type { GameFormat } from '~/db/schema'
import {
  fetchFreeCourts,
  fetchFreeCourtsEverywhere,
  fetchLocations,
  fetchReach,
  postGame,
} from '~/fn/games'
import type { FreeCourtsByLocation } from '~/server/booking'
import { searchPlayers } from '~/fn/profile'
import { mixedSeatGenders } from '~/server/formats'
import { NTRP_LEVELS } from '~/server/rating'
import {
  DAY,
  MINUTE,
  courtHourOptions,
  formatRange,
  toDateInput,
  zonedToUtc,
} from '~/server/time'

export const Route = createFileRoute('/games/new')({
  // Arriving from a drag on a location's day view carries the whole choice
  // through, so the form opens already answered.
  validateSearch: z.object({
    locationId: z.string().optional(),
    courtId: z.string().optional(),
    date: z.string().optional(),
    startMinute: z.coerce.number().optional(),
    duration: z.coerce.number().optional(),
  }),
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
    return { user: context.user }
  },
  loader: () => fetchLocations(),
  component: NewGame,
})

const DURATIONS = [
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 90, label: '1½ hours' },
  { minutes: 120, label: '2 hours' },
  { minutes: 180, label: '3 hours' },
]

function durationOptions(current: number) {
  // A duration dragged out on the court grid can be any multiple of 30
  // minutes, so make sure the one in play is always offered.
  if (DURATIONS.some((d) => d.minutes === current)) return DURATIONS
  return [...DURATIONS, { minutes: current, label: `${current / 60} hours` }].sort(
    (a, b) => a.minutes - b.minutes,
  )
}

type SeatChoice =
  | { kind: 'seeker'; seekerNtrp: number; seekerGender?: 'woman' | 'man' | null }
  | { kind: 'invited'; invitedUserId: string; invitedName: string }

function NewGame() {
  const locations = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const search = Route.useSearch()
  const router = useRouter()

  const [locationId, setLocationId] = useState(
    // Their most preferred location, when they've listed any.
    search.locationId ?? user.preferredLocationIds?.[0] ?? locations[0]?.id ?? '',
  )
  const [date, setDate] = useState(search.date ?? toDateInput(Date.now() + DAY))
  const [startMinute, setStartMinute] = useState(search.startMinute ?? 17 * 60)
  const [duration, setDuration] = useState(search.duration ?? 90)
  const [format, setFormat] = useState<GameFormat>(
    user.formats?.some((f) => f === 'doubles' || f === 'mixed_doubles') ? 'doubles' : 'singles',
  )
  const [isMixed, setIsMixed] = useState(false)
  const [courtId, setCourtId] = useState('')
  /**
   * Courts the host would also accept, tried after their first choice.
   * Defaults to every other free court — see the court effect below.
   */
  const [backupCourtIds, setBackupCourtIds] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [seats, setSeats] = useState<SeatChoice[]>([])

  const [freeCourts, setFreeCourts] = useState<Array<{ id: string; name: string }> | null>(null)
  /** Free courts at every *other* location, for hosts happy to travel. */
  const [elsewhere, setElsewhere] = useState<FreeCourtsByLocation[]>([])
  /** Other locations the host would also accept, in the order they picked. */
  const [alsoLocationIds, setAlsoLocationIds] = useState<string[]>([])
  /**
   * True while the court list is being refetched for a changed location or
   * time. Submitting during that window would post against the court selected
   * for the *previous* choice — a different court, at another location.
   */
  const [courtsLoading, setCourtsLoading] = useState(false)
  const [reach, setReach] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [y, m, d] = date.split('-').map(Number)
  const startsAt =
    y && m && d ? zonedToUtc(y, m, d, 0, startMinute) : Number.NaN
  const endsAt = startsAt + duration * MINUTE
  const timesValid = Number.isFinite(startsAt) && startsAt > Date.now()

  const seatCount = format === 'singles' ? 1 : 3

  // Everywhere except the park already chosen above.
  const otherLocations = elsewhere.filter((group) => group.locationId !== locationId)

  // Keep the seat list the right length whenever the format changes, and keep
  // a mixed game's seats balanced against the host.
  useEffect(() => {
    const genders = isMixed ? mixedSeatGenders(format, user.gender) : []
    setSeats((current) => {
      const next = current.slice(0, seatCount)
      while (next.length < seatCount) {
        next.push({ kind: 'seeker', seekerNtrp: roundToLevel(user.ntrp) })
      }
      return next.map((seat, i) =>
        seat.kind === 'seeker' ? { ...seat, seekerGender: genders[i] ?? null } : seat,
      )
    })
  }, [seatCount, user.ntrp, isMixed, user.gender, format])

  // Which courts are actually open for this window.
  useEffect(() => {
    if (!locationId || !timesValid) {
      setFreeCourts(null)
      setCourtsLoading(false)
      return
    }
    let cancelled = false
    setCourtsLoading(true)
    // Clear the stale selection immediately, so a fast click can't post
    // against a court from the location we just navigated away from.
    setCourtId('')
    setBackupCourtIds([])
    void fetchFreeCourts({ data: { locationId, startsAt, endsAt } })
      .then((courts) => {
        if (cancelled) return
        setCourtsLoading(false)
        setFreeCourts(courts)
        setCourtId((current) => {
          // Honour a court picked on the location grid, as long as it's free.
          const preferred = current || search.courtId || ''
          const chosen = courts.some((c) => c.id === preferred)
            ? preferred
            : (courts[0]?.id ?? '')
          // Every other free court is offered as a backup by default. Nothing
          // is held either way, so more options only makes it likelier the
          // game can actually be placed when it fills — and a host cares far
          // more about the time and the level than about which court.
          setBackupCourtIds(courts.filter((c) => c.id !== chosen).map((c) => c.id))
          return chosen
        })
      })
      .catch(() => {
        if (cancelled) return
        setCourtsLoading(false)
        setFreeCourts([])
      })
    return () => {
      cancelled = true
    }
  }, [locationId, startsAt, endsAt, timesValid, search.courtId])

  // What's free everywhere else, so the host can widen beyond one park. The
  // game holds nothing until it fills, so offering more costs nobody anything.
  useEffect(() => {
    if (!timesValid) {
      setElsewhere([])
      return
    }
    let cancelled = false
    void fetchFreeCourtsEverywhere({ data: { startsAt, endsAt } })
      .then((groups) => {
        if (cancelled) return
        setElsewhere(groups)
        // Drop any chosen location that no longer has a free court.
        setAlsoLocationIds((current) =>
          current.filter((id) => groups.some((g) => g.locationId === id)),
        )
      })
      .catch(() => {
        if (!cancelled) setElsewhere([])
      })
    return () => {
      cancelled = true
    }
  }, [startsAt, endsAt, timesValid])

  // How many players would hear about this. An early zero is the useful
  // signal: move the time or widen the level before posting into the void.
  const seekerLevels = [
    ...new Set(seats.filter((s) => s.kind === 'seeker').map((s) => s.seekerNtrp)),
  ].sort((a, b) => a - b)
  const seekerKey = seekerLevels.join(',')
  const genderKey = seats.map((s) => (s.kind === 'seeker' ? (s.seekerGender ?? '') : '')).join(',')
  useEffect(() => {
    if (!timesValid || seekerLevels.length === 0) {
      setReach(null)
      return
    }
    let cancelled = false
    void fetchReach({
      data: {
        startsAt,
        endsAt,
        format,
        seekerLevels,
        isMixed,
        seekerGenders: [
          ...new Set(
            seats
              .filter((s) => s.kind === 'seeker' && s.seekerGender)
              .map((s) => (s as { seekerGender: 'woman' | 'man' }).seekerGender),
          ),
        ],
      },
    })
      .then((result) => !cancelled && setReach(result.count))
      .catch(() => !cancelled && setReach(null))
    return () => {
      cancelled = true
    }
    // seekerKey rather than the array itself: a fresh array each render would
    // refire this on every keystroke elsewhere in the form.
  }, [startsAt, endsAt, format, seekerKey, timesValid, isMixed, genderKey])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result = await postGame({
        data: {
          courtIds: [
            courtId,
            ...backupCourtIds,
            // Other parks last: the host's own location comes first, and
            // within it their chosen court comes first.
            ...alsoLocationIds.flatMap(
              (id) => elsewhere.find((g) => g.locationId === id)?.courts.map((c) => c.id) ?? [],
            ),
          ].filter(Boolean),
          startsAt,
          endsAt,
          format,
          isMixed,
          notes: notes || undefined,
          slots: seats.map((seat) =>
            seat.kind === 'seeker'
              ? {
                  kind: 'seeker' as const,
                  seekerNtrp: seat.seekerNtrp,
                  seekerGender: seat.seekerGender ?? null,
                }
              : { kind: 'invited' as const, invitedUserId: seat.invitedUserId },
          ),
        },
      })
      await router.invalidate()
      router.navigate({ to: '/games/$gameId', params: { gameId: result.gameId } })
    } catch (err) {
      setError(errorMessage(err))
      setSubmitting(false)
    }
  }

  const hours = courtHourOptions()

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-lg space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Host a game</h1>
        <p className="hint mt-2">
          Pick a court and time, say who you're looking for, and we'll message players at that
          level who are free.
        </p>
      </header>

      <section className="card space-y-4 p-4">
        <p className="font-semibold">Where and when</p>

        <div>
          <label className="label" htmlFor="location">
            Location
          </label>
          <select
            id="location"
            className="input"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="date">
              Date
            </label>
            <input
              id="date"
              type="date"
              className="input"
              value={date}
              min={toDateInput(Date.now())}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="start">
              Start
            </label>
            <select
              id="start"
              className="input"
              value={startMinute}
              onChange={(e) => setStartMinute(Number(e.target.value))}
            >
              {hours.map((h) => (
                <option key={h.minute} value={h.minute}>
                  {h.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <span className="label">How long?</span>
          <div className="flex flex-wrap gap-2">
            {durationOptions(duration).map((option) => (
              <button
                key={option.minutes}
                type="button"
                onClick={() => setDuration(option.minutes)}
                className={
                  duration === option.minutes
                    ? 'chip bg-pinon-600 text-white'
                    : 'chip bg-sand-100 text-sand-700 hover:bg-sand-200'
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {timesValid ? (
          <p className="hint">{formatRange(startsAt, endsAt)} — Santa Fe time</p>
        ) : (
          <p className="hint text-clay-600">Pick a start time in the future.</p>
        )}

        <div>
          <label className="label" htmlFor="court">
            Court
          </label>
          {courtsLoading ? (
            <p className="hint" data-testid="courts-loading">
              Checking which courts are free…
            </p>
          ) : freeCourts === null ? (
            <p className="hint">Choose a time to see open courts.</p>
          ) : freeCourts.length === 0 ? (
            <p className="hint text-clay-600">
              Every court here is already claimed for that time. Try another time or location.
            </p>
          ) : (
            <>
              <select
                id="court"
                className="input"
                value={courtId}
                onChange={(e) => {
                  const next = e.target.value
                  setBackupCourtIds((current) => {
                    const withoutNext = current.filter((id) => id !== next)
                    return courtId && !withoutNext.includes(courtId)
                      ? [...withoutNext, courtId]
                      : withoutNext
                  })
                  setCourtId(next)
                }}
              >
                {freeCourts.map((court) => (
                  <option key={court.id} value={court.id}>
                    {court.name}
                  </option>
                ))}
              </select>

              {/* Extra courts the host would also accept. The game holds none
                  of them while it fills — the first that's still free when the
                  last seat goes is the one it gets — so offering more is pure
                  upside for the host and costs nobody else anything. */}
              {freeCourts.length > 1 ? (
                <fieldset className="mt-2">
                  <legend className="hint mb-1">
                    Also fine (ticked courts are backups, in this order)
                  </legend>
                  <div className="space-y-1">
                    {freeCourts
                      .filter((court) => court.id !== courtId)
                      .map((court) => (
                        <label key={court.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 accent-pinon-600"
                            checked={backupCourtIds.includes(court.id)}
                            onChange={(e) =>
                              setBackupCourtIds((current) =>
                                e.target.checked
                                  ? [...current, court.id]
                                  : current.filter((id) => id !== court.id),
                              )
                            }
                          />
                          {court.name}
                        </label>
                      ))}
                  </div>
                </fieldset>
              ) : null}

              <p className="hint mt-1">
                {freeCourts.length} court{freeCourts.length === 1 ? '' : 's'} open right now. The
                court is confirmed when the game fills, so nothing is held in the meantime —
                offering backups makes it likelier one is still free.
              </p>
            </>
          )}
        </div>

        {/* Other parks the host would also take. The game holds no court while
            it fills, so widening costs nobody anything and is the difference
            between a game that gets placed and one that goes 'unplaceable'. */}
        {otherLocations.length > 0 ? (
          <div>
            <span className="label">Other courts you'd also take</span>
            <p className="hint mb-2">
              Optional. Tried after {locations.find((l) => l.id === locationId)?.name ?? 'your first choice'},
              in the order you tick them.
            </p>
            <div className="space-y-1">
              {otherLocations.map((group) => (
                <label key={group.locationId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-pinon-600"
                    checked={alsoLocationIds.includes(group.locationId)}
                    onChange={(e) =>
                      setAlsoLocationIds((current) =>
                        e.target.checked
                          ? [...current, group.locationId]
                          : current.filter((id) => id !== group.locationId),
                      )
                    }
                  />
                  <span>
                    {group.locationName}
                    <span className="hint"> · {group.courts.length} free</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="card space-y-4 p-4">
        <p className="font-semibold">Who's playing</p>

        <div className="flex gap-2">
          {(['singles', 'doubles'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFormat(option)}
              className={
                format === option ? 'btn-primary flex-1 !py-2' : 'btn-secondary flex-1 !py-2'
              }
            >
              <span className="capitalize">{option}</span>
            </button>
          ))}
        </div>

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 size-5 accent-pinon-600"
            checked={isMixed}
            onChange={(e) => setIsMixed(e.target.checked)}
          />
          <span>
            {format === 'singles' ? 'Mixed singles' : 'Mixed doubles'}
            <span className="hint block">
              {user.gender === 'unspecified'
                ? 'Add your gender in your profile to set the seats automatically.'
                : format === 'singles'
                  ? 'The open seat is held for the opposite gender, and only players who opted into mixed singles are messaged.'
                  : 'Seats are set to keep it two and two, and only players who opted into mixed doubles are messaged.'}
            </span>
          </span>
        </label>

        <div className="rounded-lg bg-sand-100 px-3 py-2 text-sm">
          <strong>You</strong> — {user.ntrp.toFixed(1)} NTRP (host)
          {isMixed && user.gender !== 'unspecified' ? ` · ${user.gender}` : ''}
        </div>

        {seats.map((seat, index) => (
          <SeatPicker
            key={index}
            index={index}
            seat={seat}
            isMixed={isMixed}
            defaultLevel={roundToLevel(user.ntrp)}
            onChange={(next) =>
              setSeats((current) => current.map((s, i) => (i === index ? next : s)))
            }
          />
        ))}
      </section>

      <section className="card space-y-3 p-4">
        <label className="label" htmlFor="notes">
          Note for players <span className="font-normal text-ink-soft">(optional)</span>
        </label>
        <input
          id="notes"
          className="input"
          placeholder="Bring a can of balls — I'll bring water"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </section>

      {reach !== null ? (
        <div
          className={
            reach === 0
              ? 'rounded-lg border border-clay-500/40 bg-clay-100 px-3 py-2.5 text-sm text-clay-600'
              : 'rounded-lg border border-pinon-500/30 bg-pinon-50 px-3 py-2.5 text-sm text-pinon-700'
          }
        >
          {reach === 0 ? (
            <>
              No one has posted availability for this time at this level. You can still post it —
              it'll show up on the dashboard — but nobody will be messaged.
            </>
          ) : (
            <>
              <strong>{reach}</strong> player{reach === 1 ? '' : 's'} will be notified.
            </>
          )}
        </div>
      ) : null}

      <FormError message={error} />

      <button
        type="submit"
        className="btn-primary w-full"
        disabled={
          submitting ||
          courtsLoading ||
          !timesValid ||
          !courtId ||
          seats.length !== seatCount ||
          // An "invite someone" seat with nobody picked yet isn't postable.
          seats.some((seat) => seat.kind === 'invited' && !seat.invitedUserId)
        }
      >
        {submitting ? 'Posting…' : 'Post game'}
      </button>
    </form>
  )
}

function roundToLevel(ntrp: number): number {
  const first = NTRP_LEVELS[0]!
  const last = NTRP_LEVELS[NTRP_LEVELS.length - 1]!
  return Math.min(last, Math.max(first, Math.round(ntrp * 2) / 2))
}

function SeatPicker({
  index,
  seat,
  isMixed,
  defaultLevel,
  onChange,
}: {
  index: number
  seat: SeatChoice
  isMixed: boolean
  defaultLevel: number
  onChange: (seat: SeatChoice) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ id: string; name: string; ntrp: number }>>([])

  useEffect(() => {
    if (seat.kind !== 'invited' || query.trim().length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    void searchPlayers({ data: { query } })
      .then((rows) => !cancelled && setResults(rows))
      .catch(() => !cancelled && setResults([]))
    return () => {
      cancelled = true
    }
  }, [query, seat.kind])

  return (
    <div className="rounded-lg border border-sand-200 p-3">
      <p className="mb-2 text-sm font-semibold text-ink-soft">Player {index + 2}</p>

      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={() =>
            onChange({ kind: 'seeker', seekerNtrp: defaultLevel, seekerGender: null })
          }
          className={
            seat.kind === 'seeker'
              ? 'chip bg-pinon-600 text-white'
              : 'chip bg-sand-100 text-sand-700'
          }
        >
          Open to anyone
        </button>
        <button
          type="button"
          onClick={() => onChange({ kind: 'invited', invitedUserId: '', invitedName: '' })}
          className={
            seat.kind === 'invited'
              ? 'chip bg-pinon-600 text-white'
              : 'chip bg-sand-100 text-sand-700'
          }
        >
          Invite someone
        </button>
      </div>

      {seat.kind === 'seeker' ? (
        <div>
          <label className="label" htmlFor={`level-${index}`}>
            Level to look for
          </label>
          <select
            id={`level-${index}`}
            className="input"
            value={seat.seekerNtrp}
            onChange={(e) =>
              onChange({ ...seat, kind: 'seeker', seekerNtrp: Number(e.target.value) })
            }
          >
            {NTRP_LEVELS.map((level) => (
              <option key={level} value={level}>
                GameSeeker {level.toFixed(1)}
              </option>
            ))}
          </select>
          {isMixed ? (
            <div className="mt-2">
              <span className="label">Who fills this spot?</span>
              <div className="flex gap-1.5">
                {([null, 'woman', 'man'] as const).map((option) => (
                  <button
                    key={option ?? 'any'}
                    type="button"
                    onClick={() => onChange({ ...seat, seekerGender: option })}
                    className={
                      (seat.seekerGender ?? null) === option
                        ? 'chip bg-pinon-600 text-white'
                        : 'chip bg-sand-100 text-sand-700 hover:bg-sand-200'
                    }
                  >
                    {option === null ? 'Anyone' : option === 'woman' ? 'A woman' : 'A man'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <p className="hint mt-1">
            Players who said they'll play {seat.seekerNtrp.toFixed(1)}
            {seat.seekerGender ? ` and are a ${seat.seekerGender}` : ''} will be messaged.
          </p>
        </div>
      ) : (
        <div>
          {seat.invitedUserId ? (
            <div className="flex items-center gap-2">
              <span className="chip bg-pinon-100 text-pinon-700">{seat.invitedName}</span>
              <button
                type="button"
                className="hint underline"
                onClick={() => onChange({ kind: 'invited', invitedUserId: '', invitedName: '' })}
              >
                change
              </button>
            </div>
          ) : (
            <>
              <input
                className="input"
                placeholder="Search players by name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <ul className="mt-2 space-y-1">
                {results.map((player) => (
                  <li key={player.id}>
                    <button
                      type="button"
                      className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-sand-100"
                      onClick={() =>
                        onChange({
                          kind: 'invited',
                          invitedUserId: player.id,
                          invitedName: player.name,
                        })
                      }
                    >
                      {player.name}{' '}
                      <span className="text-ink-soft">{player.ntrp.toFixed(1)}</span>
                    </button>
                  </li>
                ))}
                {query.trim().length >= 2 && results.length === 0 ? (
                  <li className="hint">No players found.</li>
                ) : null}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
