// packages/@monomind/cli/src/orgrt/types-handoff.ts
import { z } from 'zod';

export const ContextSliceSchema = z.object({ source: z.string(), summary: z.string() });
export type ContextSlice = z.infer<typeof ContextSliceSchema>;
export const ArtifactRefSchema = z.object({ path: z.string(), description: z.string().optional() });
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export const HandoffDecisionSchema = z.object({
  text: z.string(),
  rationale: z.string().optional(),
});
export type HandoffDecision = z.infer<typeof HandoffDecisionSchema>;
export const OrgHandoffSchema = z.object({
  taskId: z.string().optional(),
  contextPackage: z.array(ContextSliceSchema).default([]),
  artifacts: z.array(ArtifactRefSchema).default([]),
  decisions: z.array(HandoffDecisionSchema).default([]),
  nextAction: z.string(),
});
export type OrgHandoff = z.infer<typeof OrgHandoffSchema>;

export const FailureRoutingSchema = z
  .object({
    retry: z
      .object({
        maxAttempts: z.number().int().positive(),
        backoffMs: z.array(z.number().int().nonnegative()).optional(),
      })
      .partial()
      .optional(),
    fallbackAssignee: z.string().optional(),
    escalate: z.boolean().optional(),
  })
  .partial();
export type FailureRouting = z.infer<typeof FailureRoutingSchema>;
