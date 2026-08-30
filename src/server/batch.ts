import type { BatchItem } from 'drizzle-orm/batch'

/**
 * Two small helpers shared by everything that settles a race in the database
 * rather than in application code.
 *
 * They live in their own module because both games and clinics need them, and
 * neither belongs to the other.
 */

/**
 * Drizzle's batch() wants a non-empty tuple; a plain array literal widens to
 * `Item[]` and fails to match. This preserves the tuple-ness at the call site.
 */
export function batchOf<T extends [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]>(...items: T): T {
  return items
}

/**
 * Which table a UNIQUE violation came from.
 *
 * A court collision and a player collision are both primary-key rejections out
 * of the same batch, and they mean completely different things to the person
 * who hit them — "that court just went" versus "you're already playing then".
 */
export function violates(error: unknown, table: string): boolean {
  return new RegExp(table, 'i').test(String((error as Error)?.message ?? error))
}
