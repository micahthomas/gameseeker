import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { courts, locations, users } from '~/db/schema'
import { newId } from '~/server/tokens'
import { zonedToUtc } from '~/server/time'

export const testDb = () => drizzle(env.DB, { schema })

/** Wipe every table between tests so ids and constraints start fresh. */
export async function resetDb() {
  const tables = [
    'notifications',
    'court_slot_locks',
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
  await testDb()
    .insert(users)
    .values({
      id,
      email: overrides.email ?? `${id}@example.test`,
      name: overrides.name ?? 'Player',
      ratingSystem: 'NTRP',
      ratingValue: overrides.ntrp ?? 3.5,
      ntrp: overrides.ntrp ?? 3.5,
      playsSingles: overrides.playsSingles ?? true,
      playsDoubles: overrides.playsDoubles ?? true,
      notifyEmail: overrides.notifyEmail ?? true,
      notifySms: overrides.notifySms ?? false,
      createdAt: Date.now(),
      profileCompletedAt: Date.now(),
      ...overrides,
    })
  return id
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
