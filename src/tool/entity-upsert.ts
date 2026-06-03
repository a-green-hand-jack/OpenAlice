/**
 * entity_upsert — the agent's deliberate "track this" action.
 *
 * A **workspace-scoped tool factory** (same shape as inbox_push): the agent
 * sees only `{ name, type, description }`; the workspace identity is closed
 * over by the factory at request time and never trafficked by the agent.
 *
 * The entity is created here; the *link* lives in the notes. After calling
 * this, the agent writes `[[name]]` inside the markdown it produces, and the
 * Tracked index gathers every note that contains that link. We deliberately
 * do not extract entities from prose — the agent authors both the entity and
 * the links, on purpose, as it works.
 */

import { tool } from 'ai'
import { z } from 'zod'

import type { WorkspaceToolFactory, WorkspaceToolContext } from '../core/workspace-tool-center.js'

export const entityUpsertFactory: WorkspaceToolFactory = {
  name: 'entity_upsert',
  build(ctx: WorkspaceToolContext) {
    return tool({
      description: [
        "Create or update an entity in the user's durable tracked-index — the running watchlist of",
        'things worth following across sessions. Call this the moment you decide something deserves',
        "tracking: a ticker you're watching (`asset`) or a theme that groups several of them (`topic`).",
        '',
        'Then, in the markdown you write, point at it with an Obsidian-style link: `[[name]]`. That',
        'link is the whole mechanism — the index gathers every note containing `[[name]]`, so the user',
        'can later open the entity and see every file that references it.',
        '',
        'Fields:',
        '- name: short, NO spaces, kebab-case. It is both the key and the `[[name]]` you write in prose,',
        '  so keep it terse and reuse it exactly. For an `asset` use the ticker (e.g. "vst") so the app',
        '  can pull live quotes; for a `topic` use a short phrase (e.g. "ai-data-center-power").',
        '- description: one line — what this is. The short name is ambiguous alone; this disambiguates it',
        '  (e.g. name "vst" -> "Vistra, Texas independent power producer driven by AI datacenter demand").',
        '- type: "asset" (a tradable instrument — has a ticker) or "topic" (a theme grouping assets).',
        '',
        'Before creating, prefer reusing an existing name: call entity_search first so you write',
        '`[[vst]]` consistently instead of fragmenting into both `[[vst]]` and `[[vistra]]`.',
      ].join('\n'),
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            'Short kebab/ticker key, no spaces. The `[[name]]` link target. e.g. "vst" or "ai-data-center-power".',
          ),
        type: z
          .enum(['asset', 'topic'])
          .describe('"asset" = a tradable instrument (name = its ticker); "topic" = a theme grouping assets.'),
        description: z
          .string()
          .min(1)
          .describe(
            'One line: what this is, disambiguating the short name. e.g. "Vistra, Texas independent power producer".',
          ),
      }),
      execute: async ({ name, type, description }) => {
        try {
          const entity = await ctx.entityStore.upsert({ name, type, description })
          return {
            ok: true as const,
            name: entity.name,
            link: `[[${entity.name}]]`,
            createdAt: entity.createdAt,
          }
        } catch (err) {
          return {
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      },
    })
  },
}
