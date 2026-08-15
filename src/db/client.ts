import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { env } from 'cloudflare:workers'
import * as schema from './schema'

export type DB = DrizzleD1Database<typeof schema>

/** Drizzle handle bound to the request's D1 instance. */
export function db(): DB {
  return drizzle(env.DB, { schema })
}

/**
 * The raw D1 binding. Needed for `.batch()` (atomic multi-statement writes)
 * and for reading `meta.changes` on guarded updates.
 */
export function d1(): D1Database {
  return env.DB
}

export { schema }
