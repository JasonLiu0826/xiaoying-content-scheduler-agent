import { z } from 'zod';
import {
  BusinessError, instant, requestSchema, timestampSchema,
  type Catalog, type Draft, type ItemResult, type Material, type Risk, type ScheduleRequest, type ToolError,
} from './domain.js';
import { DraftStore } from './store.js';

export const TOOL_NAMES = ['read_material', 'check_rules', 'query_slots', 'save_draft'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export interface ReviewData {
  materialId: string;
  status: 'approved' | 'missing_info' | 'blocked';
  missingFields: string[];
  risks: Risk[];
}
export interface SlotsData {
  materialId: string; requestedAt: string; requestedAvailable: boolean;
  slots: { at: string; available: boolean }[];
}
export type ToolData = { material: Material } | ReviewData | SlotsData | { draft: Draft; duplicate: boolean };
export type ToolResult = { ok: true; data: ToolData } | { ok: false; error: ToolError };

const baseArgs = { materialId: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(300) };
const readArgsSchema = z.strictObject(baseArgs);
const saveArgsSchema = z.strictObject({ ...baseArgs, suggestedAt: timestampSchema });
interface ItemState {
  result: ItemResult;
  read: boolean;
  checked: boolean;
  noSlots: boolean;
  observed: Set<string>;
  failedTools: Set<string>;
}

export class SchedulingTools {
  private readonly request: ScheduleRequest;
  private readonly catalog: Catalog;
  private readonly store: DraftStore;
  private readonly failures: Partial<Record<string, number>>;
  private readonly states = new Map<string, ItemState>();
  private initializationError?: ToolError;

  constructor(options: { request: ScheduleRequest; catalog: Catalog; store: DraftStore; failures?: Partial<Record<string, number>> }) {
    // Parsing creates a detached copy: later model or caller mutation cannot forge user consent.
    this.request = requestSchema.parse(options.request);
    this.catalog = options.catalog;
    this.store = options.store;
    this.failures = { ...options.failures };
    for (const item of this.request.items) this.states.set(item.materialId, {
      read: false, checked: false, noSlots: false, observed: new Set(), failedTools: new Set(),
      result: {
        materialId: item.materialId, channel: item.channel, requestedAt: item.requestedAt,
        reviewStatus: 'unchecked', risks: [], missingFields: [], suggestedAt: null,
        pendingConfirmations: [], draft: null, saveStatus: 'not_attempted', status: 'pending', errors: [],
      },
    });
    try { this.store.registerRequest(this.request); }
    catch (error) {
      this.initializationError = this.toError(error);
      for (const state of this.states.values()) {
        state.result.errors.push(this.initializationError); state.failedTools.add('request'); this.updateStatus(state);
      }
    }
  }

  snapshot(): ItemResult[] { return structuredClone([...this.states.values()].map(state => state.result)); }

  async execute(name: string, args: unknown): Promise<ToolResult> {
    const suppliedId = typeof args === 'object' && args !== null && 'materialId' in args ? args.materialId : undefined;
    let state = typeof suppliedId === 'string' ? this.states.get(suppliedId.trim()) : undefined;
    try {
      if (this.initializationError) return { ok: false, error: this.initializationError };
      if (!TOOL_NAMES.includes(name as ToolName)) throw new BusinessError('UNKNOWN_TOOL', `Tool ${name} is not available`);
      const parsed = (name === 'save_draft' ? saveArgsSchema : readArgsSchema).safeParse(args);
      if (!parsed.success) throw new BusinessError('INVALID_TOOL_ARGS', parsed.error.issues.map(issue => issue.message).join('; '));
      state = this.states.get(parsed.data.materialId);
      if (!state) throw new BusinessError('ITEM_NOT_REQUESTED', 'Material is not part of the immutable request');
      if ((this.failures[name] ?? 0) > 0) {
        this.failures[name]!--;
        throw new BusinessError('INJECTED_FAILURE', `Injected ${name} failure`, true);
      }
      let data: ToolData;
      switch (name as ToolName) {
        case 'read_material': data = this.read(state); break;
        case 'check_rules': data = this.check(state); break;
        case 'query_slots': data = this.query(state); break;
        case 'save_draft': data = this.save(state, saveArgsSchema.parse(args).suggestedAt); break;
      }
      state.failedTools.delete(name);
      this.updateStatus(state);
      return { ok: true, data: data! };
    } catch (error) {
      const failure = this.toError(error);
      if (state) {
        state.result.errors.push(failure); state.failedTools.add(name);
        if (name === 'save_draft') state.result.saveStatus = 'failed';
        this.updateStatus(state);
      }
      return { ok: false, error: failure };
    }
  }

  private read(state: ItemState): { material: Material } {
    const material = this.catalog.materials.find(material => material.id === state.result.materialId);
    if (!material) {
      state.result.reviewStatus = 'missing_info'; state.result.missingFields = ['material'];
      throw new BusinessError('MATERIAL_NOT_FOUND', `No material found for ${state.result.materialId}`);
    }
    state.read = true;
    return { material: structuredClone(material) };
  }

  private check(state: ItemState): ReviewData {
    const material = this.catalog.materials.find(material => material.id === state.result.materialId);
    const missingFields: string[] = [];
    if (!material) missingFields.push('material');
    else {
      if (!material.title?.trim()) missingFields.push('title');
      if (!material.description?.trim()) missingFields.push('description');
      if (!material.rights || material.rights === 'unknown') missingFields.push('rights');
    }
    const risks: Risk[] = [];
    if (material) for (const rule of this.catalog.rules) {
      for (const [field, value] of [['title', material.title], ['description', material.description]] as const) {
        if (value?.includes(rule.phrase)) risks.push({ ruleId: rule.id, reason: rule.reason,
          severity: rule.severity, evidence: `${field}: ${value}` });
      }
    }
    const status = risks.some(risk => risk.severity === 'block') ? 'blocked'
      : missingFields.length || risks.length ? 'missing_info' : 'approved';
    state.checked = true;
    Object.assign(state.result, { reviewStatus: status, missingFields, risks });
    return { materialId: state.result.materialId, status, missingFields: [...missingFields], risks: structuredClone(risks) };
  }

  private available(state: ItemState, at: string): boolean {
    return !this.catalog.occupied.some(slot => slot.channel === state.result.channel && instant(slot.at) === instant(at))
      && !this.store.isOccupied(state.result.channel, at, this.request.requestId, state.result.materialId);
  }

  private query(state: ItemState): SlotsData {
    const slots = this.catalog.candidateSlots.map(at => ({ at, available: this.available(state, at) }));
    state.observed = new Set(slots.map(slot => instant(slot.at)));
    state.noSlots = !slots.some(slot => slot.available);
    return {
      materialId: state.result.materialId, requestedAt: state.result.requestedAt,
      requestedAvailable: state.observed.has(instant(state.result.requestedAt)) && this.available(state, state.result.requestedAt), slots,
    };
  }

  private save(state: ItemState, suggestedAt: string): { draft: Draft; duplicate: boolean } {
    if (!state.read || !state.checked || !state.observed.size) {
      throw new BusinessError('PREREQUISITE_MISSING', 'Successful material read, rule check and slot query are required before saving');
    }
    if (!state.observed.has(instant(suggestedAt)) || !this.catalog.candidateSlots.some(at => instant(at) === instant(suggestedAt))) {
      throw new BusinessError('UNOBSERVED_SLOT', 'Suggestion must be a catalog slot observed through query_slots');
    }
    const item = this.request.items.find(item => item.materialId === state.result.materialId)!;
    const changedHardTime = item.hardTime && instant(item.requestedAt) !== instant(suggestedAt);
    const confirmed = this.request.confirmations.some(confirmation => confirmation.materialId === item.materialId
      && confirmation.channel === item.channel && instant(confirmation.requestedAt) === instant(item.requestedAt)
      && instant(confirmation.suggestedAt) === instant(suggestedAt));
    const status = changedHardTime && !confirmed ? 'pending_confirmation' : 'confirmed';
    const result = this.store.save(this.request, item, suggestedAt, status, () => {
      if (this.check(state).status !== 'approved') throw new BusinessError('REVIEW_NOT_APPROVED', 'Material review must be approved before saving');
      if (!this.available(state, suggestedAt)) throw new BusinessError('SLOT_CONFLICT', 'Suggested channel/time is occupied; query slots again', true);
    });
    state.result.draft = result.draft;
    state.result.suggestedAt = result.draft.suggestedAt;
    state.result.saveStatus = 'saved';
    return result;
  }

  private updateStatus(state: ItemState): void {
    const result = state.result;
    result.pendingConfirmations = result.risks.filter(risk => risk.severity === 'review').map(risk => `${risk.ruleId}: ${risk.reason}`);
    if (result.draft?.status === 'pending_confirmation') result.pendingConfirmations.push(
      `Confirm ${result.materialId} on ${result.channel}: ${result.requestedAt} → ${result.draft.suggestedAt}`);
    if (state.noSlots) result.pendingConfirmations.push('No available catalog slot; provide an alternative scheduling window');
    result.status = result.reviewStatus === 'blocked' ? 'blocked'
      : result.reviewStatus === 'missing_info' ? 'needs_input'
      : state.failedTools.size ? 'failed'
      : state.noSlots ? 'needs_input'
      : result.draft?.status === 'pending_confirmation' ? 'needs_confirmation'
      : result.draft ? 'draft_saved' : 'pending';
  }

  private toError(error: unknown): ToolError {
    return error instanceof BusinessError ? { code: error.code, message: error.message, retryable: error.retryable }
      : { code: 'TOOL_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true };
  }
}
