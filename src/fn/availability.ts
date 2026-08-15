import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { FORMAT_PREFS } from '~/db/schema'
import { requireUser } from '~/server/auth'
import {
  addBlock,
  addRule,
  deleteBlock,
  deleteRule,
  expandAvailability,
  listBlocks,
  listRules,
} from '~/server/availability'
import { DAY } from '~/server/time'

export const fetchMyAvailability = createServerFn({ method: 'GET' })
  .validator(z.object({ rangeStart: z.number(), rangeEnd: z.number() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const [rules, blocks] = await Promise.all([
      listRules(user.id),
      // Widen the block query past the view window so a multi-day vacation
      // that starts before it still clips the windows inside it.
      listBlocks(user.id, data.rangeStart - 30 * DAY, data.rangeEnd + 30 * DAY),
    ])
    return {
      rules,
      blocks,
      windows: expandAvailability(rules, blocks, data.rangeStart, data.rangeEnd),
    }
  })

export const createRule = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      weekday: z.number().int().min(0).max(6),
      startMinute: z.number().int().min(0).max(24 * 60),
      endMinute: z.number().int().min(0).max(24 * 60),
      formatPref: z.enum(FORMAT_PREFS),
      /** Start of the day the rule was drawn on; see addRule. */
      effectiveFrom: z.number().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    return addRule({ ...data, userId: user.id })
  })

export const removeRule = createServerFn({ method: 'POST' })
  .validator(z.object({ ruleId: z.string() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await deleteRule(user.id, data.ruleId)
    return { ok: true as const }
  })

export const createBlock = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      startsAt: z.number(),
      endsAt: z.number(),
      kind: z.enum(['available', 'busy']),
      formatPref: z.enum(FORMAT_PREFS),
      note: z.string().trim().max(200).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    return addBlock({ ...data, userId: user.id })
  })

export const removeBlock = createServerFn({ method: 'POST' })
  .validator(z.object({ blockId: z.string() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await deleteBlock(user.id, data.blockId)
    return { ok: true as const }
  })
