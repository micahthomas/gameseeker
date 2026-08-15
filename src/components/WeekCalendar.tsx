import { useMemo } from 'react'
import {
  WEEKDAY_SHORT,
  formatMinuteOfDay,
  localDayRanges,
  localMinutes,
  zonedParts,
  zonedToUtc,
} from '~/server/time'
import {
  DAY_END_MIN,
  DAY_START_MIN,
  DragPreview,
  GRID_HEIGHT,
  GridLines,
  GridPopover,
  PendingBlock,
  TimeGutter,
  blockBounds,
  useColumnDrag,
} from './timeGrid'

/**
 * A week view you paint availability onto, the way you'd block time in a
 * calendar app. Drag down a day column to select a range, then say whether it
 * repeats weekly, is a one-off, or is time off.
 *
 * Real dates rather than an abstract week, so one grid handles all three:
 * a repeating pattern, an extra evening this Thursday, and a week away.
 */

export type CalendarEntry = {
  key: string
  startsAt: number
  endsAt: number
  kind: 'available' | 'busy'
  source: 'rule' | 'block'
  sourceId: string
  label?: string | null
}

export type DraftSelection = {
  /** Local midnight of the day the selection sits in. */
  dayStart: number
  startMinute: number
  endMinute: number
  startsAt: number
  endsAt: number
  weekday: number
}

export type PopoverAnchor = {
  /** Local midnight of the day the popover points at. */
  dayStart: number
  startMinute: number
  endMinute: number
}

type Props = {
  weekStart: number
  entries: CalendarEntry[]
  onSelect: (draft: DraftSelection) => void
  onEntryClick: (entry: CalendarEntry) => void
  busy?: boolean
  /** A selection awaiting confirmation. Stays drawn on the grid until saved. */
  draft?: DraftSelection | null
  /** The entry currently being edited, drawn with a ring. */
  activeKey?: string | null
  /** Where to pin `popover`. */
  anchor?: PopoverAnchor | null
  popover?: React.ReactNode
}

export function WeekCalendar({
  weekStart,
  entries,
  onSelect,
  onEntryClick,
  busy,
  draft,
  activeKey,
  anchor,
  popover,
}: Props) {
  const days = useMemo(() => localDayRanges(weekStart, 7), [weekStart])

  const { gridProps, drag } = useColumnDrag({
    columnCount: 7,
    disabled: busy,
    onSelect: ({ column, startMinute, endMinute }) => {
      const day = days[column]
      if (!day) return
      const parts = zonedParts(day.start)
      onSelect({
        dayStart: day.start,
        startMinute,
        endMinute,
        startsAt: zonedToUtc(parts.year, parts.month, parts.day, 0, startMinute),
        endsAt: zonedToUtc(parts.year, parts.month, parts.day, 0, endMinute),
        weekday: parts.weekday,
      })
    },
  })

  const today = new Date().setHours(0, 0, 0, 0)

  return (
    // No overflow-hidden: the popover deliberately extends past the grid.
    <div className="card select-none">
      {/* Day headings */}
      <div className="flex border-b border-sand-200 bg-white">
        <div className="w-12 shrink-0" />
        <div className="grid flex-1 grid-cols-7">
          {days.map((day) => {
            const parts = zonedParts(day.start)
            const isToday = new Date(day.start).setHours(0, 0, 0, 0) === today
            return (
              <div key={day.start} className="py-2 text-center" data-testid="day-heading">
                <div className="text-xs font-semibold text-ink-soft">
                  {WEEKDAY_SHORT[parts.weekday]}
                </div>
                <div
                  className={
                    isToday
                      ? 'mx-auto mt-0.5 grid size-6 place-items-center rounded-full bg-pinon-600 text-sm font-bold text-white'
                      : 'mt-0.5 text-sm font-semibold'
                  }
                >
                  {parts.day}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex">
        <TimeGutter />

        {/* The grid itself */}
        <div
          {...gridProps}
          className="relative grid flex-1 cursor-crosshair grid-cols-7 touch-none"
          style={{ height: GRID_HEIGHT }}
          role="application"
          aria-label="Weekly availability. Drag to add a time."
        >
          {days.map((day, dayIndex) => (
            <div key={day.start} className="relative border-l border-sand-200 first:border-l-0">
              {/* Each rule carries the day and minute it stands for, which
                  gives tests something to point at instead of computing pixel
                  coordinates against a shifting layout. */}
              <GridLines column={dayIndex} />

              {entries
                .filter((entry) => entry.startsAt < day.end && entry.endsAt > day.start)
                .map((entry) => (
                  <EntryBlock
                    key={entry.key}
                    entry={entry}
                    dayStart={day.start}
                    dayEnd={day.end}
                    active={entry.key === activeKey}
                    onClick={() => onEntryClick(entry)}
                  />
                ))}

              {/* The confirmed-but-unsaved selection stays on the grid, so
                  the time you picked doesn't vanish while you decide. */}
              {draft && draft.dayStart === day.start ? (
                <PendingBlock startMinute={draft.startMinute} endMinute={draft.endMinute} />
              ) : null}

              {drag && drag.column === dayIndex ? <DragPreview drag={drag} /> : null}
            </div>
          ))}

          {anchor && popover ? (
            <GridPopover
              column={days.findIndex((d) => d.start === anchor.dayStart)}
              columnCount={7}
              startMinute={anchor.startMinute}
            >
              {popover}
            </GridPopover>
          ) : null}
        </div>
      </div>
    </div>
  )
}


function minuteWithinDay(instant: number, dayStart: number, dayEnd: number, fallback: number) {
  if (instant <= dayStart) return DAY_START_MIN
  if (instant >= dayEnd) return DAY_END_MIN
  const minute = localMinutes(instant)
  return minute === 0 && fallback === DAY_END_MIN ? DAY_END_MIN : minute
}

function EntryBlock({
  entry,
  dayStart,
  dayEnd,
  active,
  onClick,
}: {
  entry: CalendarEntry
  dayStart: number
  dayEnd: number
  active?: boolean
  onClick: () => void
}) {
  const startMinute = minuteWithinDay(entry.startsAt, dayStart, dayEnd, DAY_START_MIN)
  const endMinute = minuteWithinDay(entry.endsAt, dayStart, dayEnd, DAY_END_MIN)

  const { top, height } = blockBounds(startMinute, endMinute)
  if (endMinute <= startMinute) return null

  const isBusy = entry.kind === 'busy'

  return (
    <button
      type="button"
      data-entry
      onClick={onClick}
      title={`${formatMinuteOfDay(startMinute)} – ${formatMinuteOfDay(endMinute)}`}
      className={`absolute inset-x-0.5 overflow-hidden rounded px-1 text-left text-[10px] leading-tight font-semibold ${
        isBusy
          ? 'border border-clay-500/50 bg-clay-100 text-clay-600'
          : 'bg-pinon-500 text-white hover:bg-pinon-600'
      } ${active ? 'z-10 ring-2 ring-ink ring-offset-1' : ''}`}
      style={{ top: `${top}%`, height: `${height}%` }}
    >
      {isBusy ? 'Time off' : formatMinuteOfDay(startMinute).replace(' ', '')}
      {entry.source === 'rule' && !isBusy ? <span className="opacity-75"> ↻</span> : null}
    </button>
  )
}
