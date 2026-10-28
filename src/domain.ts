import { z } from 'zod';

const identifier = z.string().trim().min(1).max(200);
/** Date comparisons and SQLite keys use milliseconds, so reject unsupported finer precision. */
export const timestampSchema = z.iso.datetime({ offset: true }).refine(
  value => (value.match(/\.(\d+)/)?.[1]?.length ?? 0) <= 3,
  { message: 'Timestamps support at most three fractional second digits' },
);
export const itemSchema = z.strictObject({
  materialId: identifier,
  channel: identifier,
  requestedAt: timestampSchema,
  hardTime: z.boolean().default(true),
});
const confirmationSchema = z.strictObject({
  materialId: identifier, channel: identifier,
  requestedAt: timestampSchema, suggestedAt: timestampSchema,
});
export const requestSchema = z.strictObject({
  requestId: identifier,
  items: z.array(itemSchema).min(1).max(100),
  confirmations: z.array(confirmationSchema).max(100).default([]),
}).refine(request => new Set(request.items.map(item => item.materialId)).size === request.items.length,
  { message: 'Each materialId must be unique within a request', path: ['items'] });

export const materialSchema = z.strictObject({
  id: identifier, title: z.string().optional(), description: z.string().optional(),
  rights: z.enum(['owned', 'licensed', 'unknown']).optional(),
});
export const catalogSchema = z.strictObject({
  materials: z.array(materialSchema),
  rules: z.array(z.strictObject({
    id: identifier, phrase: z.string().trim().min(1), reason: z.string().trim().min(1),
    severity: z.enum(['block', 'review']),
  })),
  occupied: z.array(z.strictObject({ materialId: identifier, channel: identifier, at: timestampSchema })),
  candidateSlots: z.array(timestampSchema),
}).refine(catalog => new Set(catalog.materials.map(material => material.id)).size === catalog.materials.length,
  { message: 'Catalog material IDs must be unique', path: ['materials'] });

export type ScheduleRequest = z.infer<typeof requestSchema>;
export type ScheduleItem = z.infer<typeof itemSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
export type Material = z.infer<typeof materialSchema>;
export interface Risk { ruleId: string; reason: string; severity: 'block' | 'review'; evidence: string }
export interface ToolError { code: string; message: string; retryable: boolean }
export interface Draft {
  id: string;
  materialId: string;
  channel: string;
  requestedAt: string;
  suggestedAt: string;
  status: 'confirmed' | 'pending_confirmation';
}
export interface ItemResult {
  materialId: string;
  channel: string;
  requestedAt: string;
  reviewStatus: 'unchecked' | 'approved' | 'missing_info' | 'blocked';
  risks: Risk[];
  missingFields: string[];
  suggestedAt: string | null;
  pendingConfirmations: string[];
  draft: Draft | null;
  saveStatus: 'not_attempted' | 'saved' | 'failed';
  status: 'pending' | 'draft_saved' | 'needs_input' | 'blocked' | 'needs_confirmation' | 'failed';
  errors: ToolError[];
}

export function instant(at: string): string { return new Date(at).toISOString(); }

export class BusinessError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}
