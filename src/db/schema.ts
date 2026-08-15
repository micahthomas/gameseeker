import { sql } from 'drizzle-orm'
import {
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
 * Self-described, and optional: 'unspecified' is a first-class answer. It only
 * ever narrows things — a player who hasn't said can still play singles and
 * ordinary doubles, they just can't fill a seat that exists to keep a mixed
 * game mixed.
 */
export const GENDERS = ['woman', 'man', 'nonbinary', 'unspecified'] as const
export const FORMAT_PREFS = ['singles', 'doubles', 'either'] as const
export const LOCATION_KINDS = ['public_park', 'club', 'rec_center', 'school'] as const
export const SURFACES = ['hard', 'clay', 'har-tru', 'other'] as const
export const GAME_STATUSES = ['open', 'full', 'cancelled', 'completed'] as const
export const SLOT_KINDS = ['host', 'invited', 'seeker'] as const
export const SLOT_STATUSES = ['open', 'filled', 'declined'] as const
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
    gender: text('gender', { enum: GENDERS }).notNull().default('unspecified'),
    notifyEmail: integer('notify_email', { mode: 'boolean' }).notNull().default(true),
    notifySms: integer('notify_sms', { mode: 'boolean' }).notNull().default(false),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
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
    courtId: text('court_id')
      .notNull()
      .references(() => courts.id, { onDelete: 'restrict' }),
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
     * woman 3.5". Null everywhere else, which means anyone at the level.
     */
    seekerGender: text('seeker_gender', { enum: ['woman', 'man'] }),
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
export const playerSlotLocks = sqliteTable(
  'player_slot_locks',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Epoch ms, always aligned to a 30-minute boundary. */
    slotStart: integer('slot_start').notNull(),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.slotStart] }),
    index('player_slot_locks_game_idx').on(t.gameId),
    index('player_slot_locks_user_idx').on(t.userId),
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
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.courtId, t.slotStart] }),
    index('court_slot_locks_game_idx').on(t.gameId),
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
export type GameFormat = (typeof GAME_FORMATS)[number]
export type PlayerFormat = (typeof PLAYER_FORMATS)[number]
export type Gender = (typeof GENDERS)[number]
export type FormatPref = (typeof FORMAT_PREFS)[number]
export type RatingSystem = (typeof RATING_SYSTEMS)[number]
