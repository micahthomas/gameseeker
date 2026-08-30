import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import {
  fetchClinicFormData,
  fetchCourtsForSeries,
  postClinic,
  requestUploadTicket,
} from '~/fn/clinics'
import { renderMarkdown } from '~/server/markdown'
import {
  WEEKDAY_SHORT,
  addLocalDays,
  courtHourOptions,
  formatDate,
  fromDateInput,
  toDateInput,
} from '~/server/time'

/**
 * Setting up a clinic.
 *
 * The court list is filtered by what is free on *every* date of the series,
 * because creation is all-or-nothing — a court that clashes on week 4 can't
 * take the booking at all, and offering it here would only produce a failure
 * the organizer has to decode.
 */
export const Route = createFileRoute('/clinics/new')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
    if (context.user.organizerStatus !== 'approved' && !context.user.isAdmin) {
      throw redirect({ to: '/profile' })
    }
    return { user: context.user }
  },
  loader: () => fetchClinicFormData(),
  component: NewClinic,
})

function NewClinic() {
  const { locations, courts } = Route.useLoaderData()
  const router = useRouter()

  const [locationId, setLocationId] = useState(locations[0]?.id ?? '')
  const [courtId, setCourtId] = useState('')
  const [title, setTitle] = useState('')
  const [descriptionMd, setDescriptionMd] = useState('')
  const [costNote, setCostNote] = useState('')
  const [capacity, setCapacity] = useState(8)
  const [weekdays, setWeekdays] = useState<number[]>([])
  const [startMinute, setStartMinute] = useState(18 * 60)
  const [endMinute, setEndMinute] = useState(19 * 60)
  const [from, setFrom] = useState(toDateInput(addLocalDays(Date.now(), 7)))
  const [until, setUntil] = useState(toDateInput(addLocalDays(Date.now(), 56)))

  const [hero, setHero] = useState<{ key: string; width: number; height: number } | null>(null)
  const [freeCourtIds, setFreeCourtIds] = useState<string[] | null>(null)
  const [conflicts, setConflicts] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const fromMs = fromDateInput(from)
  const untilMs = fromDateInput(until)
  const ready = Boolean(locationId && weekdays.length && fromMs && untilMs && endMinute > startMinute)

  const locationCourts = courts.filter((c) => c.locationId === locationId)

  // Which courts are free for the whole series. Refetched whenever anything
  // that defines the series changes, since the answer depends on all of it.
  useEffect(() => {
    if (!ready) {
      setFreeCourtIds(null)
      return
    }
    let cancelled = false
    void fetchCourtsForSeries({
      data: {
        locationId,
        recurrence: { weekdays, startMinute, endMinute, from: fromMs!, until: untilMs! },
      },
    })
      .then((result) => {
        if (!cancelled) setFreeCourtIds(result.courtIds)
      })
      .catch(() => {
        if (!cancelled) setFreeCourtIds(null)
      })
    return () => {
      cancelled = true
    }
  }, [locationId, weekdays.join(','), startMinute, endMinute, from, until, ready])

  // A court that stops being free while the form is open must not stay picked;
  // submitting it would fail the whole create for a reason nothing showed.
  useEffect(() => {
    if (courtId && freeCourtIds && !freeCourtIds.includes(courtId)) setCourtId('')
  }, [freeCourtIds, courtId])

  async function uploadHero(file: File) {
    setError(null)
    try {
      const { ticket } = await requestUploadTicket()
      const response = await fetch(`/api/media/upload?ticket=${encodeURIComponent(ticket)}`, {
        method: 'PUT',
        body: file,
      })
      const result = (await response.json()) as
        | { ok: true; key: string }
        | { ok: false; reason: string }
      if (!result.ok) {
        setError(result.reason)
        return
      }
      // Measured in the browser so the page can reserve the space later.
      const size = await new Promise<{ width: number; height: number }>((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
        img.onerror = () => resolve({ width: 0, height: 0 })
        img.src = URL.createObjectURL(file)
      })
      setHero({ key: result.key, width: size.width, height: size.height })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setConflicts([])
    setBusy(true)
    try {
      const result = await postClinic({
        data: {
          locationId,
          courtId,
          title,
          descriptionMd,
          costNote: costNote || undefined,
          heroKey: hero?.key,
          heroWidth: hero?.width || undefined,
          heroHeight: hero?.height || undefined,
          capacity,
          recurrence: { weekdays, startMinute, endMinute, from: fromMs!, until: untilMs! },
        },
      })

      if (!result.ok) {
        setConflicts(result.conflicts)
        return
      }
      await router.navigate({
        to: '/clinics/$clinicId/manage',
        params: { clinicId: result.clinicId },
      })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const hours = courtHourOptions()

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Set up a clinic</h1>
        <p className="hint mt-2">
          The court is held for every date as soon as you create this, so a session runs
          whether or not anyone signs up. You can publish it once the description reads right.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-5">
        <section className="card space-y-4 p-4">
          <div>
            <label className="label" htmlFor="title">
              What is it?
            </label>
            <input
              id="title"
              className="input"
              value={title}
              maxLength={120}
              required
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Cardio Tennis"
            />
          </div>

          <div>
            <label className="label" htmlFor="location">
              Where
            </label>
            <select
              id="location"
              className="input"
              value={locationId}
              onChange={(e) => {
                setLocationId(e.target.value)
                setCourtId('')
              }}
            >
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="label">Which days</span>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_SHORT.map((label, weekday) => (
                <button
                  key={label}
                  type="button"
                  className={
                    weekdays.includes(weekday)
                      ? 'chip bg-pinon-600 text-white'
                      : 'chip bg-sand-100 text-sand-700'
                  }
                  aria-pressed={weekdays.includes(weekday)}
                  onClick={() =>
                    setWeekdays((current) =>
                      current.includes(weekday)
                        ? current.filter((d) => d !== weekday)
                        : [...current, weekday].sort(),
                    )
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="start">
                From
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
            <div>
              <label className="label" htmlFor="end">
                To
              </label>
              <select
                id="end"
                className="input"
                value={endMinute}
                onChange={(e) => setEndMinute(Number(e.target.value))}
              >
                {hours.map((h) => (
                  <option key={h.minute} value={h.minute}>
                    {h.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="from">
                Starting
              </label>
              <input
                id="from"
                type="date"
                className="input"
                value={from}
                min={toDateInput(Date.now())}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="until">
                Until
              </label>
              <input
                id="until"
                type="date"
                className="input"
                value={until}
                min={from}
                onChange={(e) => setUntil(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="court">
              Court
            </label>
            {!ready ? (
              <p className="hint">Pick the days and times first.</p>
            ) : freeCourtIds === null ? (
              <p className="hint" data-testid="courts-loading">
                Checking what's free…
              </p>
            ) : (
              <select
                id="court"
                className="input"
                value={courtId}
                required
                data-testid="clinic-courts"
                onChange={(e) => setCourtId(e.target.value)}
              >
                <option value="">Choose a court…</option>
                {locationCourts
                  .filter((c) => freeCourtIds.includes(c.id))
                  .map((court) => (
                    <option key={court.id} value={court.id}>
                      {court.name}
                    </option>
                  ))}
              </select>
            )}
            <p className="hint mt-1">
              Only courts free on every date are listed — the whole series is booked at once.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="capacity">
              Places per session
            </label>
            <input
              id="capacity"
              type="number"
              className="input"
              min={1}
              max={40}
              value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value))}
            />
          </div>
        </section>

        <section className="card space-y-4 p-4">
          <div>
            <label className="label" htmlFor="description">
              Description
            </label>
            <textarea
              id="description"
              className="input"
              rows={7}
              maxLength={4000}
              value={descriptionMd}
              onChange={(e) => setDescriptionMd(e.target.value)}
              placeholder={'## What to expect\n\nAn hour of continuous play.\n\n- Bring water\n- **All levels welcome**'}
            />
            <p className="hint mt-1">
              Markdown: <code>##</code> headings, <code>- </code> lists, <code>**bold**</code>,{' '}
              <code>_italic_</code> and links.
            </p>
          </div>

          {descriptionMd.trim() ? (
            <div>
              <span className="label">Preview</span>
              <div
                className="rounded-lg bg-sand-50 p-3 text-sm leading-relaxed"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(descriptionMd) }}
              />
            </div>
          ) : null}

          <div>
            <label className="label" htmlFor="cost">
              Cost <span className="font-normal text-ink-soft">(optional)</span>
            </label>
            <input
              id="cost"
              className="input"
              maxLength={140}
              value={costNote}
              onChange={(e) => setCostNote(e.target.value)}
              placeholder="$15 drop-in, cash at the court"
            />
            <p className="hint mt-1">
              Shown to players and settled at the court. No money goes through GameSeeker.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="hero">
              Photo <span className="font-normal text-ink-soft">(optional)</span>
            </label>
            <input
              id="hero"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="input"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void uploadHero(file)
              }}
            />
            {hero ? (
              <img
                src={`/api/media/${hero.key}`}
                alt=""
                className="mt-2 aspect-[16/9] w-full rounded-lg object-cover"
              />
            ) : null}
          </div>
        </section>

        {conflicts.length > 0 ? (
          <div className="card border-clay-500 p-4 text-sm" data-testid="clinic-conflicts">
            <p className="font-semibold">That court is already booked on some of these dates.</p>
            <ul className="hint mt-2 space-y-0.5">
              {conflicts.map((startsAt) => (
                <li key={startsAt}>{formatDate(startsAt)}</li>
              ))}
            </ul>
            <p className="hint mt-2">
              Nothing was created. Pick another court, or move the time.
            </p>
          </div>
        ) : null}

        <FormError message={error} />

        <button type="submit" className="btn-primary" disabled={busy || !ready || !courtId}>
          {busy ? 'Booking…' : 'Create clinic'}
        </button>
      </form>
    </div>
  )
}
