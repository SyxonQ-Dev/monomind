// packages/@monomind/cli/src/orgrt/types-cost.ts
import { z } from 'zod';
import { ORG_EFFORT_LEVELS } from './cost-tier.js';

/** ADR-O001 D8 cost tiers. Keys are provider keys — a Vercel vendor slug
 *  (`glm`, `openai`, …) when the role has one, else the role's runtime id
 *  (`claude`, `codex`, `kimicode`, …) — so a tier is expressible for a
 *  provider this code has never heard of without touching code. Resolution,
 *  the built-in Claude catalog and the deliberative-role warning live in
 *  orgrt/cost-tier.ts. */
const EffortLevelSchema = z.enum(ORG_EFFORT_LEVELS);
export const CostTiersSchema = z
  .object({
    /** Tier applied to every role with no `roles` entry of its own. */
    default: z.string().optional(),
    /** Per-role tier. A bare string is a tier name or `"exempt"`; the object
     *  form also overrides the tier's effort — how "patrol roles drop effort
     *  since they do simpler, more repetitive work" is expressed. */
    roles: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.object({ tier: z.string(), effort: EffortLevelSchema.optional() }).passthrough(),
        ]),
      )
      .optional(),
    /** tier name → provider key → { model, effort }. Merged over the built-in
     *  catalog per provider, so adding one provider to a built-in tier keeps
     *  the rest of that tier. */
    tiers: z
      .record(
        z.string(),
        z.record(
          z.string(),
          z
            .object({ model: z.string().min(1), effort: EffortLevelSchema.optional() })
            .passthrough(),
        ),
      )
      .optional(),
    /** provider key → how that provider expresses an effort level. Claude is
     *  handled natively (the SDK's own `effort`/`thinking` options); anything
     *  else declares env vars here, or encodes effort in the per-tier model id
     *  (e.g. `gemini-3.6-flash-high`). A provider with neither ignores it. */
    providers: z
      .record(
        z.string(),
        z
          .object({
            // partialRecord, not record: z.record() over an enum key demands
            // EVERY level be present, so an org declaring only `low` would be
            // rejected for not also declaring medium/high/xhigh/max.
            effort_env: z
              .partialRecord(EffortLevelSchema, z.record(z.string(), z.string()))
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** ADR-O001 D7: one named loadout — a stable bundle of role-prompt text and
 *  skills that becomes part of the SYSTEM PROMPT of the session serving a
 *  task. Validation (catalog size, names, skills, file) and resolution live in
 *  orgrt/loadouts.ts. */
export const LoadoutSchema = z
  .object({
    /** One line shown to the boss in org_task's description, to select by. */
    description: z.string().optional(),
    /** Role-prompt text for this kind of work. */
    prompt: z.string().optional(),
    /** Skills from the org skill library (orgrt/skill-library.ts) to include. */
    skills: z.array(z.string()).optional(),
    /** Extra guidance file, resolved against the project root. */
    instructions_file: z.string().optional(),
  })
  .passthrough();

/** ADR-O001 D4's number: three failed evidence checks on one task, then
 *  escalate instead of handing it back again. Exported so the call site can
 *  fall back to it for an org definition that never went through the schema
 *  (a hand-built RunningOrg, a config written before this field existed). */
export const DEFAULT_MAX_EVIDENCE_ATTEMPTS = 3;
