import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import type { FormatPref } from '~/db/schema'
import {
  createBlock,
  createRule,
  fetchMyAvailability,
  removeBlock,
  removeRule,
} from '~/fn/availability'
import {
  DAY,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  courtHourOptions,
  formatDateTime,
  formatMinuteOfDay,
  formatRange,
  parseLocalInput,
  toLocalInput,
} from '~/server/time'

const VIEW_DAYS = 14

export const Route = createFileRoute('/availability')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
  },
  loader: () => {
    const now = Date.now()
    return fetchMyAvailability({ data: { rangeStart: now, rangeEnd: now + VIEW_DAYS * DAY } })
  },
  component: Availability,
})

const FORMAT_LABELS: Record<FormatPref, string> = {
  either: 'Singles or doubles',
  singles: 'Singles only',
  doubles: 'Doubles only',
}

function Availability() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      await router.invalidate()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold">When can you play?</h1>
        <p className="hint mt-2">
          These times decide which games you hear about. Nobody sees your calendar — it's only used
          to match you.
        </p>
      </header>

      <FormError message={error} />

      <WeeklySection rules={data.rules} onRun={run} busy={busy} />
      <OneOffSection blocks={data.blocks} onRun={run} busy={busy} />
      <UpcomingSection windows={data.windows} />
    </div>
  )
}

// ---------------------------------------------------------------------------

function WeeklySection({
  rules,
  onRun,
  busy,
}: {
  rules: Array<{
    id: string
    weekday: number
    startMinute: number
    endMinute: number
    formatPref: FormatPref
  }>
  onRun: (action: () => Promise<unknown>) => Promise<void>
  busy: boolean
}) {
  const [weekday, setWeekday] = useState(2)
  const [startMinute, setStartMinute] = useState(17 * 60)
  const [endMinute, setEndMinute] = useState(19 * 60)
  const [formatPref, setFormatPref] = useState<FormatPref>('either')

  const hours = courtHourOptions()
  const invalid = endMinute <= startMinute

  return (
    <section>
      <h2 className="text-lg font-bold">Every week</h2>
      <p className="hint mt-1">
        Your standing schedule. Set it once — "Tuesdays and Thursdays after work" — and it keeps
        matching.
      </p>

      <WeekBars rules={rules} />

      <ul className="mt-3 space-y-2">
        {rules.length === 0 ? (
          <li className="hint">No weekly times yet.</li>
        ) : (
          rules.map((rule) => (
            <li key={rule.id} className="card flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {WEEKDAY_NAMES[rule.weekday]}, {formatMinuteOfDay(rule.startMinute)} –{' '}
                  {formatMinuteOfDay(rule.endMinute)}
                </p>
                <p className="hint">{FORMAT_LABELS[rule.formatPref]}</p>
              </div>
              <button
                className="btn-danger !px-3 !py-1.5 !text-sm"
                disabled={busy}
                onClick={() => onRun(() => removeRule({ data: { ruleId: rule.id } }))}
              >
                Remove
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="card mt-3 space-y-3 p-4">
        <p className="font-semibold">Add a weekly time</p>

        <div className="flex flex-wrap gap-1.5">
          {WEEKDAY_SHORT.map((label, index) => (
            <button
              key={label}
              type="button"
              onClick={() => setWeekday(index)}
              className={
                weekday === index
                  ? 'chip bg-pinon-600 text-white'
                  : 'chip bg-sand-100 text-sand-700 hover:bg-sand-200'
              }
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="rule-start">
              From
            </label>
            <select
              id="rule-start"
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
            <label className="label" htmlFor="rule-end">
              Until
            </label>
            <select
              id="rule-end"
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

        <div>
          <label className="label" htmlFor="rule-format">
            Format
          </label>
          <select
            id="rule-format"
            className="input"
            value={formatPref}
            onChange={(e) => setFormatPref(e.target.value as FormatPref)}
          >
            {Object.entries(FORMAT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {invalid ? <p className="hint text-clay-600">"Until" must be after "from".</p> : null}

        <button
          className="btn-primary w-full"
          disabled={busy || invalid}
          onClick={() =>
            onRun(() => createRule({ data: { weekday, startMinute, endMinute, formatPref } }))
          }
        >
          Add weekly time
        </button>
      </div>
    </section>
  )
}

/** A week-at-a-glance strip: 6am at the top, 10pm at the bottom. */
function WeekBars({
  rules,
}: {
  rules: Array<{ id: string; weekday: number; startMinute: number; endMinute: number }>
}) {
  const dayStart = 6 * 60
  const dayEnd = 22 * 60
  const span = dayEnd - dayStart

  return (
    <div className="card mt-3 grid grid-cols-7 gap-1 p-3">
      {WEEKDAY_SHORT.map((label, index) => (
        <div key={label} className="text-center">
          <p className="text-xs font-semibold text-ink-soft">{label}</p>
          <div className="relative mt-1 h-24 overflow-hidden rounded bg-sand-100">
            {rules
              .filter((rule) => rule.weekday === index)
              .map((rule) => {
                const top = ((Math.max(rule.startMinute, dayStart) - dayStart) / span) * 100
                const height =
                  ((Math.min(rule.endMinute, dayEnd) - Math.max(rule.startMinute, dayStart)) /
                    span) *
                  100
                return (
                  <div
                    key={rule.id}
                    className="absolute inset-x-0.5 rounded-sm bg-pinon-500"
                    style={{ top: `${top}%`, height: `${Math.max(height, 4)}%` }}
                  />
                )
              })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

function OneOffSection({
  blocks,
  onRun,
  busy,
}: {
  blocks: Array<{
    id: string
    startsAt: number
    endsAt: number
    kind: 'available' | 'busy'
    formatPref: FormatPref
    note: string | null
  }>
  onRun: (action: () => Promise<unknown>) => Promise<void>
  busy: boolean
}) {
  const tomorrow = Date.now() + DAY
  const [kind, setKind] = useState<'available' | 'busy'>('available')
  const [startsAt, setStartsAt] = useState(toLocalInput(tomorrow))
  const [endsAt, setEndsAt] = useState(toLocalInput(tomorrow + 2 * 60 * 60 * 1000))
  const [note, setNote] = useState('')

  const start = parseLocalInput(startsAt)
  const end = parseLocalInput(endsAt)
  const invalid = !Number.isFinite(start) || !Number.isFinite(end) || end <= start

  return (
    <section>
      <h2 className="text-lg font-bold">One-off times</h2>
      <p className="hint mt-1">
        Extra availability for a specific date, or time off that overrides your weekly schedule.
      </p>

      <ul className="mt-3 space-y-2">
        {blocks.length === 0 ? (
          <li className="hint">Nothing scheduled.</li>
        ) : (
          blocks.map((block) => (
            <li key={block.id} className="card flex items-center gap-3 p-3">
              <span
                className={
                  block.kind === 'busy'
                    ? 'chip bg-clay-100 text-clay-600'
                    : 'chip bg-pinon-100 text-pinon-700'
                }
              >
                {block.kind === 'busy' ? 'Time off' : 'Free'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{formatRange(block.startsAt, block.endsAt)}</p>
                <p className="hint">
                  {block.note || (block.kind === 'busy' ? 'Unavailable' : FORMAT_LABELS[block.formatPref])}
                </p>
              </div>
              <button
                className="btn-danger !px-3 !py-1.5 !text-sm"
                disabled={busy}
                onClick={() => onRun(() => removeBlock({ data: { blockId: block.id } }))}
              >
                Remove
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="card mt-3 space-y-3 p-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setKind('available')}
            className={kind === 'available' ? 'btn-primary flex-1 !py-2' : 'btn-secondary flex-1 !py-2'}
          >
            I'm free
          </button>
          <button
            type="button"
            onClick={() => setKind('busy')}
            className={kind === 'busy' ? 'btn-primary flex-1 !py-2' : 'btn-secondary flex-1 !py-2'}
          >
            Time off
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="block-start">
              From
            </label>
            <input
              id="block-start"
              type="datetime-local"
              className="input"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="block-end">
              Until
            </label>
            <input
              id="block-end"
              type="datetime-local"
              className="input"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="block-note">
            Note <span className="font-normal text-ink-soft">(optional)</span>
          </label>
          <input
            id="block-note"
            className="input"
            placeholder={kind === 'busy' ? 'Out of town' : 'Free all afternoon'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {invalid ? <p className="hint text-clay-600">"Until" must be after "from".</p> : null}
        <p className="hint">All times are Santa Fe time (Mountain).</p>

        <button
          className="btn-primary w-full"
          disabled={busy || invalid}
          onClick={() =>
            onRun(() =>
              createBlock({
                data: {
                  startsAt: start,
                  endsAt: end,
                  kind,
                  formatPref: 'either',
                  note: note || undefined,
                },
              }),
            )
          }
        >
          {kind === 'busy' ? 'Block this time' : 'Add this time'}
        </button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

function UpcomingSection({
  windows,
}: {
  windows: Array<{ startsAt: number; endsAt: number; source: 'rule' | 'block' }>
}) {
  return (
    <section>
      <h2 className="text-lg font-bold">Next two weeks</h2>
      <p className="hint mt-1">
        Exactly when you can be matched, after weekly times and time off are combined.
      </p>
      <ul className="mt-3 space-y-1.5">
        {windows.length === 0 ? (
          <li className="card p-4 text-center">
            <p className="font-semibold">No availability in the next two weeks</p>
            <p className="hint mt-1">Add a weekly time above so hosts can find you.</p>
          </li>
        ) : (
          windows.map((w) => (
            <li
              key={`${w.startsAt}-${w.endsAt}-${w.source}`}
              className="flex items-center gap-2 rounded-lg border border-sand-200 bg-white px-3 py-2 text-sm"
            >
              <span className="size-2 shrink-0 rounded-full bg-pinon-500" />
              <span>{formatRange(w.startsAt, w.endsAt)}</span>
              {w.source === 'block' ? (
                <span className="chip ml-auto bg-sand-100 text-sand-700">one-off</span>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </section>
  )
}
