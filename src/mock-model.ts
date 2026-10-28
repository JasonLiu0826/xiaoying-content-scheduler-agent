import { requestSchema } from './domain.js';
import type { ChatModel, Message, ToolDefinition } from './protocol.js';
import type { ReviewData, SlotsData, ToolResult } from './tools.js';

interface ObservedCall { materialId: string; name: string; result: ToolResult }

/** Deterministic offline substitute. This validates plumbing, never real model decisions. */
export class OfflineMockModel implements ChatModel {
  readonly kind = 'mock' as const;
  readonly name = 'deterministic-offline-mock';
  private calls = 0;

  async complete(messages: Message[], _tools: ToolDefinition[]): Promise<Message> {
    const request = requestSchema.parse(JSON.parse(messages.find(message => message.role === 'user')!.content!));
    const observed = this.observations(messages);
    for (const item of request.items) {
      const history = observed.filter(call => call.materialId === item.materialId);
      const reads = history.filter(call => call.name === 'read_material');
      if (!reads.length) return this.choose('read_material', item.materialId, '离线模拟：先获取素材事实');
      if (!reads.at(-1)!.result.ok) {
        const error = reads.at(-1)!.result as Extract<ToolResult, { ok: false }>;
        if (error.error.retryable && reads.length < 2) return this.choose('read_material', item.materialId, '离线模拟：读取工具暂时失败，有限重试');
        continue;
      }
      const reviews = history.filter(call => call.name === 'check_rules');
      if (!reviews.length) return this.choose('check_rules', item.materialId, '离线模拟：检查素材完整性与规则风险');
      const review = reviews.at(-1)!.result;
      if (!review.ok || (review.data as ReviewData).status !== 'approved') continue;
      const queries = history.filter(call => call.name === 'query_slots');
      if (!queries.length) return this.choose('query_slots', item.materialId, '离线模拟：审核通过，查询真实占用情况');
      const query = queries.at(-1)!.result;
      if (!query.ok) {
        if (query.error.retryable && queries.length < 2) return this.choose('query_slots', item.materialId, '离线模拟：时段查询失败，有限重试');
        continue;
      }
      const saves = history.filter(call => call.name === 'save_draft');
      if (saves.at(-1)?.result.ok || saves.length >= 2) continue;
      const slots = query.data as SlotsData;
      const approval = request.confirmations.find(confirmation => confirmation.materialId === item.materialId);
      const approved = approval && slots.slots.find(slot => slot.available && new Date(slot.at).getTime() === new Date(approval.suggestedAt).getTime());
      const suggestedAt = approved?.at ?? (slots.requestedAvailable ? item.requestedAt : slots.slots.find(slot => slot.available)?.at);
      if (!suggestedAt) continue;
      return this.choose('save_draft', item.materialId,
        saves.length ? '离线模拟：保存失败后仅重试一次' : slots.requestedAvailable ? '离线模拟：原要求时段可用，保存草稿' : '离线模拟：原时段冲突，建议替代时段并保留人工确认边界', { suggestedAt });
    }
    return this.choose('finish', undefined, '离线模拟：已处理所有素材，按实际保存回执、缺口或失败结束');
  }

  private choose(name: string, materialId: string | undefined, reason: string, extra = {}): Message {
    return { role: 'assistant', content: null, tool_calls: [{ id: `mock-${++this.calls}`, type: 'function',
      function: { name, arguments: JSON.stringify({ ...(materialId ? { materialId } : {}), reason, ...extra }) } }] };
  }

  private observations(messages: Message[]): ObservedCall[] {
    const calls = new Map<string, { materialId: string; name: string }>();
    const results: ObservedCall[] = [];
    for (const message of messages) {
      for (const call of message.tool_calls ?? []) {
        const args = JSON.parse(call.function.arguments) as { materialId?: string };
        if (args.materialId) calls.set(call.id, { materialId: args.materialId, name: call.function.name });
      }
      if (message.role === 'tool' && message.tool_call_id && calls.has(message.tool_call_id)) {
        results.push({ ...calls.get(message.tool_call_id)!, result: JSON.parse(message.content!) as ToolResult });
      }
    }
    return results;
  }
}
