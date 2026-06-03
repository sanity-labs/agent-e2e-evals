import { z } from 'zod';

const variantTypeSchema = z.enum(['baseline', 'mcp', 'skills']);
export type VariantType = z.infer<typeof variantTypeSchema>;

const thinkingLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const experimentMetadataSchema = z.object({
  modelName: z.string().min(1),
  displayName: z.string().min(1),
  variant: variantTypeSchema,
  thinkingLevel: thinkingLevelSchema.optional(),
});
export type ExperimentMetadata = z.infer<typeof experimentMetadataSchema>;
