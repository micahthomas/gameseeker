import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { courts, locations, users, type PlayerFormat } from '~/db/schema'
import { defaultFormats } from '~/server/formats'
import { defaultPlayLevels } from '~/server/rating'
import { newId } from '~/server/tokens'
import { zonedToUtc } from '~/server/time'

export const testDb = () => drizzle(env.DB, { schema })

/** Wipe every table between tests so ids and constraints start fresh. */
export async function resetDb() {
  const tables = [
    'notifications',
    'court_slot_locks',
    'player_slot_locks',
    'game_slots',
    'games',
    'availability_blocks',
    'availability_rules',
    'sessions',
    'magic_tokens',
    'users',
    'courts',
    'locations',
  ]
  for (const table of tables) {
    await env.DB.prepare(`DELETE FROM ${table}`).run()
  }
}

export async function makeLocation(name = 'Test Park') {
  const id = newId()
  await testDb().insert(locations).values({
    id,
    name,
    address: null,
    lat: null,
    lng: null,
    kind: 'public_park',
    notes: null,
    isActive: true,
    createdAt: Date.now(),
  })
  return id
}

export async function makeCourt(locationId: string, name = 'Court 1') {
  const id = newId()
  await testDb().insert(courts).values({
    id,
    locationId,
    name,
    surface: 'hard',
    hasLights: false,
    isActive: true,
    sortOrder: 1,
  })
  return id
}

export async function makeUser(
  overrides: Partial<typeof users.$inferInsert> & { ntrp?: number } = {},
) {
  const id = overrides.id ?? newId()
  const ntrp = overrides.ntrp ?? 3.5
  await testDb()
    .insert(users)
    .values({
      id,
      email: overrides.email ?? `${id}@example.test`,
      name: overrides.name ?? 'Player',
      ratingSystem: 'NTRP',
      ratingValue: ntrp,
      ntrp,
      // Tests default to "plays only at my own level" so level matching is
      // explicit; pass playLevels to opt into more.
      playLevels: overrides.playLevels ?? [ntrp],
      // All four by default, so a test only has to say something about
      // formats when formats are what it's testing.
      formats: overrides.formats ?? defaultFormats(),
      notifyEmail: overrides.notifyEmail ?? true,
      notifySms: overrides.notifySms ?? false,
      createdAt: Date.now(),
      profileCompletedAt: Date.now(),
      ...overrides,
    })
  return id
}

/** A claimant, in the shape claimSlot/claimAnyOpenSlot expect. */
export async function makePlayer(
  overrides: Partial<typeof users.$inferInsert> & { ntrp?: number } = {},
) {
  const ntrp = overrides.ntrp ?? 3.5
  const id = await makeUser(overrides)
  return {
    id,
    ntrp,
    playLevels: (overrides.playLevels as number[]) ?? [ntrp],
    gender: overrides.gender ?? 'unspecified',
    formats: (overrides.formats as PlayerFormat[]) ?? defaultFormats(),
  }
}

/** A Santa Fe wall-clock time, as an instant. */
export function localTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number {
  return zonedToUtc(year, month, day, hour, minute)
}
