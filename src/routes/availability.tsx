import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import { useState } from 'react'
import { FormError, errorMessage } from '~/components/ErrorPanel'
import {
  WeekCalendar,
  type CalendarEntry,
  type DraftSelection,
  type PopoverAnchor,
} from '~/components/WeekCalendar'
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
  addLocalDays,
  formatDate,
  formatMinuteOfDay,
  formatRange,
  fromDateInput,
  localDayRanges,
  localMinutes,
  localWeekday,
  startOfLocalDay,
  toDateInput,
} from '~/server/time'

/**
 * Monday of the week containing `ms`, at local midnight.
 *
 * Stepping with addLocalDays rather than subtracting milliseconds keeps this
 * anchored to the wall clock: a fixed -7 days lands an hour off across a DST
 * change, which is how a week view starts drifting as you page through it.
 */
function weekStartFor(ms: number): number {
  const day = startOfLocalDay(ms)
  const mondayOffset = (localWeekday(day) + 6) % 7 // Sun -> 6, Mon -> 0
  return startOfLocalDay(addLocalDays(day, -mondayOffset))
}

/** Same weekday, `weeks` weeks away. */
function shiftWeeks(weekStart: number, weeks: number): number {
  return startOfLocalDay(addLocalDays(weekStart, weeks * 7))
}

export const Route = createFileRoute('/availability')({
  /**
   * The week on screen lives in the URL, so leaving the page and coming back
   * returns to the week you were looking at rather than to this one.
   */
  validateSearch: z.object({ week: z.string().optional() }),
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
  },
  loader: () => {
    const start = weekStartFor(Date.now())
    // Fetch a generous span so paging a week either way is instant.
    //
    // Deliberately *not* keyed on the week in the URL. These are the viewer's
    // own entries, so there's no freshness argument for refetching as they
    // page, and making the loader depend on the week would turn every click
    // into a round trip — a page that used to move instantly would start
    // waiting. Paging beyond this span shows an empty week, which it already
    // did before the week reached the URL.
    return fetchMyAvailability({
      data: { rangeStart: start - 28 * DAY, rangeEnd: start + 56 * DAY },
    })
  },
  component: Availability,
})

type Draft = DraftSelection | null

function Availability() {
  const data = Route.useLoaderData()
  const router = useRouter()

  // Derived from the URL rather than mirrored into state, so the two can't
  // drift and browser back/forward pages the week for free.
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const weekStart = weekStartFor((search.week ? fromDateInput(search.week) : null) ?? Date.now())

  /**
   * `replace`, so paging through a month doesn't leave four history entries
   * between here and wherever you came from.
   *
   * A relative step resolves against the search the *router* currently holds,
   * not the one this render closed over. `navigate` is async, so a click that
   * lands before React has re-rendered would otherwise step from the previous
   * week and skip one — press Next, Previous, Next quickly and you arrive two
   * weeks out instead of one.
   */
  const setWeekStart = (next: number | ((current: number) => number)) => {
    if (typeof next !== 'function') {
      void navigate({ search: { week: toDateInput(next) }, replace: true })
      return
    }
    void navigate({
      search: (prev) => {
        const current = weekStartFor((prev.week ? fromDateInput(prev.week) : null) ?? Date.now())
        return { week: toDateInput(next(current)) }
      },
      replace: true,
    })
  }
  const [draft, setDraft] = useState<Draft>(null)
  const [selected, setSelected] = useState<CalendarEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      await router.invalidate()
      setDraft(null)
      setSelected(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  // Expanded recurring windows and one-off blocks, plus time off, all as one
  // list the grid can draw.
  const entries: CalendarEntry[] = [
    ...data.windows.map((w) => ({
      key: `w-${w.source}-${w.sourceId}-${w.startsAt}`,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      kind: 'available' as const,
      source: w.source,
      sourceId: w.sourceId,
    })),
    ...data.blocks
      .filter((b) => b.kind === 'busy')
      .map((b) => ({
        key: `b-${b.id}`,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        kind: 'busy' as const,
        source: 'block' as const,
        sourceId: b.id,
        label: b.note,
      })),
  ]

  // The popover points at whichever thing is being decided on.
  const anchor: PopoverAnchor | null = draft
    ? { dayStart: draft.dayStart, startMinute: draft.startMinute, endMinute: draft.endMinute }
    : selected
      ? {
          dayStart: startOfLocalDay(selected.startsAt),
          startMinute: localMinutes(selected.startsAt),
          endMinute: localMinutes(selected.endsAt) || 24 * 60,
        }
      : null

  const popoverContent = draft ? (
    <NewSelection
      draft={draft}
      busy={busy}
      onCancel={() => setDraft(null)}
      onEveryWeek={() =>
        run(() =>
          createRule({
            data: {
              weekday: draft.weekday,
              startMinute: draft.startMinute,
              endMinute: draft.endMinute,
              formatPref: 'either',
              effectiveFrom: draft.dayStart,
            },
          }),
        )
      }
      onJustThisDate={() =>
        run(() =>
          createBlock({
            data: {
              startsAt: draft.startsAt,
              endsAt: draft.endsAt,
              kind: 'available',
              formatPref: 'either',
            },
          }),
        )
      }
      onTimeOff={() =>
        run(() =>
          createBlock({
            data: {
              startsAt: draft.startsAt,
              endsAt: draft.endsAt,
              kind: 'busy',
              formatPref: 'either',
            },
          }),
        )
      }
    />
  ) : selected ? (
    <ExistingSelection
      entry={selected}
      busy={busy}
      onCancel={() => setSelected(null)}
      onRemoveSeries={() => run(() => removeRule({ data: { ruleId: selected.sourceId } }))}
      onRemoveOne={() =>
        run(() =>
          createBlock({
            data: {
              startsAt: selected.startsAt,
              endsAt: selected.endsAt,
              kind: 'busy',
              formatPref: 'either',
              note: 'Skipped this week',
            },
          }),
        )
      }
      onRemoveBlock={() => run(() => removeBlock({ data: { blockId: selected.sourceId } }))}
    />
  ) : null

  const weekDays = localDayRanges(weekStart, 7)
  const weekLabel = `${formatDate(weekStart).replace(/^\w+, /, '')} – ${formatDate(
    weekDays[6]!.start,
  ).replace(/^\w+, /, '')}`

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">When can you play?</h1>
        <p className="hint mt-2">
          Drag on the calendar to add a time. These decide which games you hear about — nobody else
          sees your schedule.
        </p>
      </header>

      <FormError message={error} />

      <div className="flex items-center gap-2">
        <button
          className="btn-secondary !px-3 !py-1.5 !text-sm"
          onClick={() => setWeekStart((w) => shiftWeeks(w, -1))}
          aria-label="Previous week"
        >
          ←
        </button>
        <button
          className="btn-secondary !px-3 !py-1.5 !text-sm"
          onClick={() => setWeekStart(weekStartFor(Date.now()))}
        >
          Today
        </button>
        <button
          className="btn-secondary !px-3 !py-1.5 !text-sm"
          onClick={() => setWeekStart((w) => shiftWeeks(w, 1))}
          aria-label="Next week"
        >
          →
        </button>
        <p className="ml-auto text-sm font-semibold" data-testid="week-range">
          {weekLabel}
        </p>
      </div>

      <WeekCalendar
        weekStart={weekStart}
        entries={entries}
        busy={busy}
        draft={draft}
        activeKey={selected?.key ?? null}
        anchor={anchor}
        popover={popoverContent}
        onSelect={(next) => {
          setSelected(null)
          setDraft(next)
        }}
        onEntryClick={(entry) => {
          setDraft(null)
          setSelected(entry)
        }}
      />

      <div className="flex flex-wrap items-center gap-4 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-pinon-500" /> Available
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm border border-clay-500/50 bg-clay-100" /> Time off
        </span>
        <span className="flex items-center gap-1.5">↻ Repeats weekly</span>
      </div>

      <WeeklySummary rules={data.rules} busy={busy} onRemove={(ruleId) => run(() => removeRule({ data: { ruleId } }))} />
    </div>
  )
}

function NewSelection({
  draft,
  busy,
  onCancel,
  onEveryWeek,
  onJustThisDate,
  onTimeOff,
}: {
  draft: DraftSelection
  busy: boolean
  onCancel: () => void
  onEveryWeek: () => void
  onJustThisDate: () => void
  onTimeOff: () => void
}) {
  return (
    <div
      className="card space-y-2 p-3 shadow-lg shadow-ink/10"
      role="dialog"
      aria-label="Add this time"
    >
      <div>
        <p className="text-sm font-bold">
          {formatMinuteOfDay(draft.startMinute)} – {formatMinuteOfDay(draft.endMinute)}
        </p>
        <p className="text-xs text-ink-soft">{formatDate(draft.dayStart)}</p>
      </div>
      <div className="grid gap-1.5">
        <button className="btn-primary !py-2 !text-sm" disabled={busy} onClick={onEveryWeek}>
          Every {WEEKDAY_NAMES[draft.weekday]}
        </button>
        <button className="btn-secondary !py-2 !text-sm" disabled={busy} onClick={onJustThisDate}>
          Just this date
        </button>
        <button className="btn-danger !py-2 !text-sm" disabled={busy} onClick={onTimeOff}>
          Mark as time off
        </button>
      </div>
      <button className="w-full text-xs text-ink-soft underline" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

function ExistingSelection({
  entry,
  busy,
  onCancel,
  onRemoveSeries,
  onRemoveOne,
  onRemoveBlock,
}: {
  entry: CalendarEntry
  busy: boolean
  onCancel: () => void
  onRemoveSeries: () => void
  onRemoveOne: () => void
  onRemoveBlock: () => void
}) {
  const repeating = entry.source === 'rule' && entry.kind === 'available'

  return (
    <div
      className="card space-y-2 p-3 shadow-lg shadow-ink/10"
      role="dialog"
      aria-label="Edit this time"
    >
      <div>
        <p className="text-sm font-bold">{formatRange(entry.startsAt, entry.endsAt)}</p>
        <p className="text-xs text-ink-soft">
          {entry.kind === 'busy'
            ? entry.label || 'Time off'
            : repeating
              ? 'Part of a weekly repeating time.'
              : 'A one-off time.'}
        </p>
      </div>

      <div className="grid gap-1.5">
        {repeating ? (
          <>
            <button className="btn-secondary !py-2 !text-sm" disabled={busy} onClick={onRemoveOne}>
              Skip just this week
            </button>
            <button className="btn-danger !py-2 !text-sm" disabled={busy} onClick={onRemoveSeries}>
              Remove every week
            </button>
          </>
        ) : (
          <button className="btn-danger !py-2 !text-sm" disabled={busy} onClick={onRemoveBlock}>
            Remove
          </button>
        )}
      </div>
      <button className="w-full text-xs text-ink-soft underline" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

function WeeklySummary({
  rules,
  busy,
  onRemove,
}: {
  rules: Array<{ id: string; weekday: number; startMinute: number; endMinute: number }>
  busy: boolean
  onRemove: (ruleId: string) => void
}) {
  if (rules.length === 0) {
    return (
      <p className="hint">
        No repeating times yet. Drag on a day above and choose “Every&nbsp;…” to set a standing
        schedule.
      </p>
    )
  }

  return (
    <section>
      <h2 className="text-lg font-bold">Repeats every week</h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {rules.map((rule) => (
          <li key={rule.id} className="flex items-center gap-2 rounded-lg bg-white border border-sand-200 px-3 py-1.5 text-sm">
            <span className="font-semibold">
              {WEEKDAY_NAMES[rule.weekday]} {formatMinuteOfDay(rule.startMinute)}–
              {formatMinuteOfDay(rule.endMinute)}
            </span>
            <button
              className="text-ink-soft hover:text-clay-600"
              disabled={busy}
              aria-label={`Remove ${WEEKDAY_NAMES[rule.weekday]} weekly time`}
              onClick={() => onRemove(rule.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
