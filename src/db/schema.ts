import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * All timestamps are UTC epoch milliseconds (SQLite INTEGER). Rendering into
 * America/Denver happens at the edges — see src/server/time.ts.
 */

export const RATING_SYSTEMS = ['NTRP', 'UTR'] as const
/** What a game *is*. Mixed is a separate flag on the game, not a fifth format. */
export const GAME_FORMATS = ['singles', 'doubles'] as const
/**
 * What a player opts into, as a set.
 *
 * Four independent choices rather than two booleans plus a mixed flag. The old
 * shape couldn't express "I'll play mixed singles but not ordinary singles",
 * and it carried an awkward special case — `plays_mixed` only ever meant
 * doubles. A game's `(format, is_mixed)` pair maps onto exactly one of these,
 * and a player matches when it's in their set. See playerFormat().
 */
export const PLAYER_FORMATS = ['singles', 'mixed_singles', 'doubles', 'mixed_doubles'] as const
/**
 * Which side of a mixed game a player fills — a statement about the tennis
 * they play, not about who they are.
 *
 * This replaced a `gender` column ('woman' | 'man' | 'nonbinary' |
 * 'unspecified'), and the distinction is the whole point. The only question
 * the app ever needed answered was "which of a mixed game's two sides can you
 * take?", and asking for an identity to infer that was both more information
 * than it needed and a worse fit: it forced non-binary players into a bracket
 * the format doesn't have, and it stored personal data to derive a scheduling
 * fact. A division is something a player already knows about themselves in
 * tennis terms, and they answer it directly.
 *
 * 'unspecified' stays a first-class answer and behaves exactly as it did: it
 * only ever narrows things. Such a player plays singles and ordinary doubles
 * freely, and can still take a mixed seat that isn't held to a side — they
 * just can't fill one that exists to keep the game balanced.
 */
export const DIVISIONS = ['mens', 'womens', 'unspecified'] as const
/** The two a mixed seat can actually be held for. */
export const SEAT_DIVISIONS = ['mens', 'womens'] as const
export const FORMAT_PREFS = ['singles', 'doubles', 'either'] as const
export const LOCATION_KINDS = ['public_park', 'club', 'rec_center', 'school'] as const
export const SURFACES = ['hard', 'clay', 'har-tru', 'other'] as const
/**
 * `unplaceable` is the flexible-booking failure: the game filled up, and by
 * then every court the host offered had gone. Deliberately a state the host
 * is told about rather than a silent cancellation — the players are real and
 * willing, only the venue is missing. See `assignCourt`.
 */
export const GAME_STATUSES = ['open', 'full', 'cancelled', 'completed', 'unplaceable'] as const
export const SLOT_KINDS = ['host', 'invited', 'seeker'] as const
export const SLOT_STATUSES = ['open', 'filled', 'declined'] as const
/**
 * Running a clinic means holding a public court for weeks at a time, so it is
 * granted rather than claimed. `declined` is kept rather than reset to `none`
 * so a refusal isn't quietly re-requestable, and so the admin list stays
 * honest about what was already decided.
 */
export const ORGANIZER_STATUSES = ['none', 'requested', 'approved', 'declined'] as const
/**
 * `draft` holds a clinic back from the world while its description is being
 * written — but the courts are already held, because a clinic takes them at
 * creation. Publishing is what sends the announcement, and it happens once.
 */
export const CLINIC_STATUSES = ['draft', 'published', 'cancelled'] as const
export const OCCURRENCE_STATUSES = ['scheduled', 'cancelled', 'completed'] as const

export const CHANNELS = ['email', 'sms'] as const
export const NOTIFICATION_STATUSES = ['sent', 'failed', 'claimed', 'expired'] as const

export const locations = sqliteTable('locations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  address: text('address'),
  lat: real('lat'),
  lng: real('lng'),
  kind: text('kind', { enum: LOCATION_KINDS }).notNull().default('public_park'),
  notes: text('notes'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
})

export const courts = sqliteTable(
  'courts',
  {
    id: text('id').primaryKey(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    surface: text('surface', { enum: SURFACES }).notNull().default('hard'),
    hasLights: integer('has_lights', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('courts_location_idx').on(t.locationId)],
)

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    ratingSystem: text('rating_system', { enum: RATING_SYSTEMS }).notNull().default('NTRP'),
    /** The value as the player entered it, in their own system. */
    ratingValue: real('rating_value').notNull(),
    /** Normalized NTRP (2.0-5.5). Their actual level, shown to other players. */
    ntrp: real('ntrp').notNull(),
    /**
     * The levels this player is willing to play, e.g. [3.5, 4.0]. Matching is
     * opt-in against this set rather than an automatic band around `ntrp`: a
     * 3.5 happy to play up gets 4.0 alerts, and one who isn't, doesn't.
     * Always contains at least one level.
     */
    playLevels: text('play_levels', { mode: 'json' })
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * The formats this player will play, e.g. ['doubles', 'mixed_doubles'].
     * Same opt-in intersection rule as `playLevels`: a game reaches a player
     * only if its format is in here. Always contains at least one entry.
     */
    formats: text('formats', { mode: 'json' })
      .$type<PlayerFormat[]>()
      .notNull()
      .default(sql`'[]'`),
    division: text('division', { enum: DIVISIONS }).notNull().default('unspecified'),
    notifyEmail: integer('notify_email', { mode: 'boolean' }).notNull().default(true),
    notifySms: integer('notify_sms', { mode: 'boolean' }).notNull().default(false),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    /** Whether this player may run clinics. Granted by an admin, not claimed. */
    organizerStatus: text('organizer_status', { enum: ORGANIZER_STATUSES })
      .notNull()
      .default('none'),
    /** What they said when they asked. Context for whoever decides. */
    organizerNote: text('organizer_note'),
    organizerRequestedAt: integer('organizer_requested_at'),
    /**
     * Clinic announcements, which are a separate opt-in from game alerts: a
     * clinic isn't matched to a level or a format, so it reaches a wider set
     * of people and deserves its own switch.
     */
    notifyClinics: integer('notify_clinics', { mode: 'boolean' }).notNull().default(true),
    /**
     * Null until the player confirms name and rating. Sign-in creates the row
     * from an email address alone, so this is what distinguishes a real profile
     * from a stub and gates them into the profile form on first visit.
     */
    profileCompletedAt: integer('profile_completed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    // Case-insensitive uniqueness: emails are always stored lowercased.
    uniqueIndex('users_email_unique').on(t.email),
    index('users_ntrp_idx').on(t.ntrp),
  ],
)

/**
 * Where a player prefers to play, in priority order. `rank` 0 is most
 * preferred.
 *
 * A table rather than a JSON column on `users`, because this is joined against
 * — candidate ordering and game lists both need it in SQL, and `json_each`
 * against every row to sort a list is the wrong shape.
 *
 * This is a *soft* preference. Nothing filters on it: a player who never
 * listed a location still hears about games there, just later in the ordering.
 * At town scale a hard filter risks a small pool going quiet, which is worse
 * than an imperfectly ordered invitation list. Replaced the single optional
 * `users.home_location_id`, which nothing used for matching at all.
 */
export const userLocations = sqliteTable(
  'user_locations',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    /** 0 = most preferred. Contiguous from 0 within a player's list. */
    rank: integer('rank').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.locationId] }),
    index('user_locations_location_idx').on(t.locationId),
  ],
)

/** Recurring weekly availability, e.g. "Tuesdays 17:00-19:00". */
export const availabilityRules = sqliteTable(
  'availability_rules',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 0 = Sunday .. 6 = Saturday, in America/Denver local time. */
    weekday: integer('weekday').notNull(),
    /** Minutes from local midnight, e.g. 17:00 => 1020. */
    startMinute: integer('start_minute').notNull(),
    endMinute: integer('end_minute').notNull(),
    formatPref: text('format_pref', { enum: FORMAT_PREFS }).notNull().default('either'),
    effectiveFrom: integer('effective_from').notNull(),
    effectiveUntil: integer('effective_until'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('avail_rules_user_idx').on(t.userId, t.weekday)],
)

/**
 * One-off availability. `kind: 'busy'` is a blackout that overrides recurring
 * rules ("out of town next week").
 */
export const availabilityBlocks = sqliteTable(
  'availability_blocks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at').notNull(),
    kind: text('kind', { enum: ['available', 'busy'] }).notNull().default('available'),
    formatPref: text('format_pref', { enum: FORMAT_PREFS }).notNull().default('either'),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('avail_blocks_user_time_idx').on(t.userId, t.startsAt, t.endsAt)],
)

export const games = sqliteTable(
  'games',
  {
    id: text('id').primaryKey(),
    hostId: text('host_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Null until the game fills. Courts are no longer held while a game is
     * still looking for players — see `game_court_options` and the booking
     * note in CLAUDE.md.
     */
    courtId: text('court_id').references(() => courts.id, { onDelete: 'restrict' }),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at').notNull(),
    format: text('format', { enum: GAME_FORMATS }).notNull(),
    /** Mixed doubles. Only meaningful when format is 'doubles'. */
    isMixed: integer('is_mixed', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: GAME_STATUSES }).notNull().default('open'),
    /** Acceptable NTRP band for open slots. */
    minNtrp: real('min_ntrp').notNull(),
    maxNtrp: real('max_ntrp').notNull(),
    notes: text('notes'),
    createdAt: integer('created_at').notNull(),
    cancelledAt: integer('cancelled_at'),
    /** Set by cron so the day-before reminder goes out exactly once. */
    remindedAt: integer('reminded_at'),
    /** Set by cron when the host was warned the game is still short players. */
    hostNudgedAt: integer('host_nudged_at'),
    /**
     * iCalendar SEQUENCE for the invite this game sends out.
     *
     * A calendar client ignores an update whose sequence hasn't advanced, so
     * this is what lets a later message move or withdraw the entry a player
     * already has rather than being silently dropped. Bumped on cancellation.
     */
    calendarSeq: integer('calendar_seq').notNull().default(0),
  },
  (t) => [
    index('games_start_idx').on(t.startsAt),
    index('games_court_idx').on(t.courtId, t.startsAt),
    index('games_status_idx').on(t.status, t.startsAt),
  ],
)

/** One row per seat. Singles => 2 rows, doubles => 4 rows. */
export const gameSlots = sqliteTable(
  'game_slots',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    slotIndex: integer('slot_index').notNull(),
    kind: text('kind', { enum: SLOT_KINDS }).notNull(),
    /** Set when the host named a specific player for this seat. */
    invitedUserId: text('invited_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Set for 'seeker' slots: the level being sought, e.g. 3.5. */
    seekerNtrp: real('seeker_ntrp'),
    /**
     * Set on a mixed game's open seats to keep the sides balanced — "we need a
     * women's 3.5". Null everywhere else, which means anyone at the level.
     */
    seekerDivision: text('seeker_division', { enum: SEAT_DIVISIONS }),
    filledByUserId: text('filled_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    filledAt: integer('filled_at'),
    status: text('status', { enum: SLOT_STATUSES }).notNull().default('open'),
  },
  (t) => [
    uniqueIndex('game_slots_game_index_unique').on(t.gameId, t.slotIndex),
    // A player can occupy at most one seat in a given game.
    uniqueIndex('game_slots_one_seat_per_player')
      .on(t.gameId, t.filledByUserId)
      .where(sql`${t.filledByUserId} IS NOT NULL`),
    index('game_slots_open_idx').on(t.status, t.seekerNtrp),
  ],
)

/**
 * The court-conflict enforcer. Courts are booked in 30-minute granules; a
 * 90-minute game inserts 3 rows. The composite primary key makes a
 * double-booking a constraint violation rather than a logic bug — see
 * src/server/booking.ts.
 */
/**
 * The courts a host would accept, best first.
 *
 * A game holds none of them while it fills. Holding every candidate would
 * block five courts for everyone else on behalf of one game that may never
 * happen, which at five-park scale is worse than the alternative: assign at
 * the moment the last seat is taken, in a single `batch()` whose court locks
 * are still settled by their primary key. The race didn't go away, it moved.
 */
export const gameCourtOptions = sqliteTable(
  'game_court_options',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    courtId: text('court_id')
      .notNull()
      .references(() => courts.id, { onDelete: 'cascade' }),
    /** 0 = the host's first choice. */
    rank: integer('rank').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.courtId] }),
    index('game_court_options_game_idx').on(t.gameId),
  ],
)

/**
 * One player, one game at a time.
 *
 * The same 30-minute granule trick as `court_slot_locks`, and for the same
 * reason: the primary key `(user_id, slot_start)` is what makes "you can't be
 * in two places at once" a *database* guarantee rather than a read-then-write
 * check that two concurrent claims could both pass.
 *
 * Written in the same `batch()` as the seat claim, so a losing race leaves no
 * trace. Removed when a player drops out and when a game is cancelled.
 */
/**
 * A clinic: an organizer holding a court on a schedule and selling seats into
 * it. Cardio tennis, a drills hour, a junior session.
 *
 * The other shape of tennis this app knows about, and deliberately not a game
 * with different numbers. A game is a group assembling itself around open
 * seats and holds no court until it fills; a clinic is one person committing
 * to a court whether or not anyone signs up, which is exactly why it takes its
 * courts at creation. See `createClinic`.
 */
export const clinics = sqliteTable(
  'clinics',
  {
    id: text('id').primaryKey(),
    organizerId: text('organizer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Every occurrence is at one location; the court is per occurrence. */
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    /** Markdown, rendered through `src/server/markdown.ts`. Never HTML. */
    descriptionMd: text('description_md').notNull().default(''),
    /**
     * Prose, not a number. No money moves through the app — an organizer
     * writes "$15 drop-in, cash at the court" and settles it there.
     */
    costNote: text('cost_note'),
    /** R2 object key, served from /api/media/<key>. Null for no image. */
    heroKey: text('hero_key'),
    /** Intrinsic size, so the page reserves the space and doesn't jump. */
    heroWidth: integer('hero_width'),
    heroHeight: integer('hero_height'),
    /** Seats per occurrence, not across the series. */
    capacity: integer('capacity').notNull(),
    status: text('status', { enum: CLINIC_STATUSES }).notNull().default('draft'),
    /**
     * The recurrence as the organizer stated it, in **local wall-clock** — the
     * same reasoning as `availability_rules`. "Tuesdays at 6pm" has no fixed
     * UTC value, and storing it as an instant would move the clinic an hour
     * twice a year. Kept for display and for editing; the occurrences below
     * are what the app actually schedules against.
     */
    recurWeekdays: text('recur_weekdays', { mode: 'json' })
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'`),
    recurStartMinute: integer('recur_start_minute').notNull(),
    recurEndMinute: integer('recur_end_minute').notNull(),
    recurFrom: integer('recur_from').notNull(),
    recurUntil: integer('recur_until').notNull(),
    createdAt: integer('created_at').notNull(),
    publishedAt: integer('published_at'),
    cancelledAt: integer('cancelled_at'),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    index('clinics_location_idx').on(t.locationId, t.status),
    index('clinics_organizer_idx').on(t.organizerId),
  ],
)

/**
 * One date of a clinic.
 *
 * Materialised rather than stored as a recurrence rule and expanded on read,
 * which is the opposite of what `availability_rules` does — and it has to be.
 * A court is held by rows in `court_slot_locks`, and there is nothing for
 * those rows to point at unless each date exists.
 */
export const clinicOccurrences = sqliteTable(
  'clinic_occurrences',
  {
    id: text('id').primaryKey(),
    clinicId: text('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    /** Not null: unlike a game, a clinic holds its court from the start. */
    courtId: text('court_id')
      .notNull()
      .references(() => courts.id, { onDelete: 'restrict' }),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at').notNull(),
    status: text('status', { enum: OCCURRENCE_STATUSES }).notNull().default('scheduled'),
    /** See the note on `games.calendar_seq`. */
    calendarSeq: integer('calendar_seq').notNull().default(0),
    /** Set by cron so the day-before reminder goes out exactly once. */
    remindedAt: integer('reminded_at'),
  },
  (t) => [
    uniqueIndex('clinic_occurrences_clinic_start_unique').on(t.clinicId, t.startsAt),
    index('clinic_occurrences_start_idx').on(t.startsAt),
    index('clinic_occurrences_court_idx').on(t.courtId, t.startsAt),
  ],
)

/**
 * A player's place on one date.
 *
 * Capacity is a number on the clinic rather than one pre-created row per seat
 * the way `game_slots` works. Four rows for a doubles game is the right shape;
 * three hundred for a twenty-person series is not, and it would freeze the
 * capacity an organizer set on day one. The race is settled instead by a
 * single guarded `INSERT ... SELECT ... WHERE (count) < capacity`, which SQLite
 * evaluates as one statement — see `signUpForClinic`.
 */
export const clinicSignups = sqliteTable(
  'clinic_signups',
  {
    id: text('id').primaryKey(),
    occurrenceId: text('occurrence_id')
      .notNull()
      .references(() => clinicOccurrences.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    // One place per player per date, however many times they hit the button.
    uniqueIndex('clinic_signups_occurrence_user_unique').on(t.occurrenceId, t.userId),
    index('clinic_signups_user_idx').on(t.userId),
  ],
)

/**
 * The dedupe row for a clinic announcement, mirroring `notifications`.
 *
 * A separate table rather than making `notifications` polymorphic: that one is
 * thoroughly game-shaped — `slot_id`, `seeker_ntrp`, a single-use `claim_token`
 * — and none of it means anything for a clinic. Written before the queue
 * message, for the same reason: the unique index is what makes at-least-once
 * delivery safe.
 */
export const clinicNotifications = sqliteTable(
  'clinic_notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clinicId: text('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    sentAt: integer('sent_at').notNull(),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('sent'),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('clinic_notifications_user_clinic_unique').on(t.userId, t.clinicId),
    index('clinic_notifications_user_idx').on(t.userId, t.sentAt),
  ],
)

export const playerSlotLocks = sqliteTable(
  'player_slot_locks',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Epoch ms, always aligned to a 30-minute boundary. */
    slotStart: integer('slot_start').notNull(),
    /** Exactly one of these two. See the note on `court_slot_locks`. */
    gameId: text('game_id').references(() => games.id, { onDelete: 'cascade' }),
    clinicOccurrenceId: text('clinic_occurrence_id').references(() => clinicOccurrences.id, {
      onDelete: 'cascade',
    }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.slotStart] }),
    index('player_slot_locks_game_idx').on(t.gameId),
    index('player_slot_locks_occurrence_idx').on(t.clinicOccurrenceId),
    index('player_slot_locks_user_idx').on(t.userId),
    check(
      'player_slot_locks_one_owner',
      sql`(${t.gameId} IS NULL) <> (${t.clinicOccurrenceId} IS NULL)`,
    ),
  ],
)

export const courtSlotLocks = sqliteTable(
  'court_slot_locks',
  {
    courtId: text('court_id')
      .notNull()
      .references(() => courts.id, { onDelete: 'cascade' }),
    /** Epoch ms, always aligned to a 30-minute boundary. */
    slotStart: integer('slot_start').notNull(),
    /**
     * Exactly one of these two owns the lock — the CHECK below is what says so.
     *
     * **One table, not two.** Games and clinics compete for the same public
     * courts, so they have to be settled by the same primary key. A separate
     * `clinic_court_locks` would let a game and a clinic be sent to the same
     * court at the same hour, which is precisely the failure this table exists
     * to make impossible. Anything else that books a court in future belongs
     * here too, as a third nullable column.
     */
    gameId: text('game_id').references(() => games.id, { onDelete: 'cascade' }),
    clinicOccurrenceId: text('clinic_occurrence_id').references(() => clinicOccurrences.id, {
      onDelete: 'cascade',
    }),
  },
  (t) => [
    primaryKey({ columns: [t.courtId, t.slotStart] }),
    index('court_slot_locks_game_idx').on(t.gameId),
    index('court_slot_locks_occurrence_idx').on(t.clinicOccurrenceId),
    check(
      'court_slot_locks_one_owner',
      sql`(${t.gameId} IS NULL) <> (${t.clinicOccurrenceId} IS NULL)`,
    ),
  ],
)

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    /** A representative open seat at the time of sending; claiming takes any
     *  equivalent open seat, so this is for context, not identity. */
    slotId: text('slot_id').references(() => gameSlots.id, { onDelete: 'set null' }),
    /** The level this player was invited to fill. */
    seekerNtrp: real('seeker_ntrp'),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    /** Single-use token embedded in the claim link. */
    claimToken: text('claim_token').notNull(),
    sentAt: integer('sent_at').notNull(),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('sent'),
    respondedAt: integer('responded_at'),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('notifications_claim_token_unique').on(t.claimToken),
    index('notifications_user_idx').on(t.userId, t.sentAt),
    // One alert per player per game, however many equivalent seats are open.
    uniqueIndex('notifications_user_game_unique').on(t.userId, t.gameId),
  ],
)

export const magicTokens = sqliteTable(
  'magic_tokens',
  {
    /** SHA-256 of the token; the raw value only ever exists in the email. */
    tokenHash: text('token_hash').primaryKey(),
    email: text('email').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('magic_tokens_expiry_idx').on(t.expiresAt)],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Location = typeof locations.$inferSelect
export type Court = typeof courts.$inferSelect
export type Game = typeof games.$inferSelect
export type GameSlot = typeof gameSlots.$inferSelect
export type AvailabilityRule = typeof availabilityRules.$inferSelect
export type AvailabilityBlock = typeof availabilityBlocks.$inferSelect
export type Notification = typeof notifications.$inferSelect
export type UserLocation = typeof userLocations.$inferSelect
export type PlayerSlotLock = typeof playerSlotLocks.$inferSelect
export type GameCourtOption = typeof gameCourtOptions.$inferSelect
export type Clinic = typeof clinics.$inferSelect
export type NewClinic = typeof clinics.$inferInsert
export type ClinicOccurrence = typeof clinicOccurrences.$inferSelect
export type ClinicSignup = typeof clinicSignups.$inferSelect
export type GameFormat = (typeof GAME_FORMATS)[number]
export type PlayerFormat = (typeof PLAYER_FORMATS)[number]
export type Division = (typeof DIVISIONS)[number]
export type SeatDivision = (typeof SEAT_DIVISIONS)[number]
export type FormatPref = (typeof FORMAT_PREFS)[number]
export type RatingSystem = (typeof RATING_SYSTEMS)[number]
export type OrganizerStatus = (typeof ORGANIZER_STATUSES)[number]
export type ClinicStatus = (typeof CLINIC_STATUSES)[number]
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number]
