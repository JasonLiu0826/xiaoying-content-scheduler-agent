import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type ToolRuntime } from '../src/agent.js';
import type { ChatModel, Message } from '../src/protocol.js';

const call = (name: string, input: Record<string, unknown>, id = name): Message => ({
  role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
});

function fixture(initialStatus = 'pending') {
  const item = { materialId: 'M01', status: initialStatus };
  const received: Array<{ name: string; input: unknown }> = [];
  const runtime = {
    async execute(name: string, input: unknown) { received.push({ name, input }); if (name === 'save_draft') item.status = 'draft_saved'; return { ok: true, data: { observed: name } }; },
    snapshot() { return [{ ...item }]; },
  } as unknown as ToolRuntime;
  return { runtime, received };
}

test('feeds actual tool observations into the next model decision and derives success from ledger', async () => {
  const { runtime, received } = fixture();
  const history: Message[][] = [];
  const responses = [call('read_material', { materialId: 'M01', reason: '读取事实' }),
    call('save_draft', { materialId: 'M01', suggestedAt: '2026-11-01T18:00:00+08:00', reason: '使用已核实的时段' }), call('finish', { reason: '已保存草稿' })];
  const model: ChatModel = { kind: 'test', name: 'observation-test', async complete(messages) { history.push(structuredClone(messages)); return responses.shift()!; } };
  const result = await runAgent({ request: { requestId: 'test', items: [] }, tools: runtime, model });
  assert.equal(result.taskStatus, 'completed');
  assert.equal(received.length, 2);
  assert.match(history[1]!.find(m => m.role === 'tool')!.content!, /observed.*read_material/);
  assert.equal(result.trace[0]?.nextAction, 'save_draft');
  assert.equal(result.trace.at(-1)?.nextAction, 'end');
});

test('a model cannot claim success by finishing before unresolved items are processed', async () => {
  const { runtime } = fixture();
  const model: ChatModel = { kind: 'test', name: 'premature', async complete() { return call('finish', { reason: '假称已完成' }); } };
  const result = await runAgent({ request: { requestId: 'test', items: [] }, tools: runtime, model, maxSteps: 2 });
  assert.equal(result.taskStatus, 'incomplete');
  assert.equal(result.stopReason, 'MAX_STEPS');
  assert.ok(result.trace.some(t => JSON.stringify(t.observation).includes('UNFINISHED_ITEMS')));
});

test('unknown tools are rejected and endless tool choices hit a strict call cap', async () => {
  const { runtime, received } = fixture();
  const model: ChatModel = { kind: 'test', name: 'endless', async complete() { return call('publish_now', { reason: '尝试发布' }); } };
  const result = await runAgent({ request: { requestId: 'test', items: [] }, tools: runtime, model, maxSteps: 10, maxToolCalls: 2 });
  assert.equal(result.taskStatus, 'incomplete');
  assert.equal(result.stopReason, 'MAX_TOOL_CALLS');
  assert.equal(result.toolCalls, 2);
  assert.equal(received.length, 0);
});

test('business failures survive the model finish and are never reported as completed', async () => {
  const { runtime } = fixture('failed');
  const model: ChatModel = { kind: 'test', name: 'failure', async complete() { return call('finish', { reason: '保存失败，停止并报告' }); } };
  const result = await runAgent({ request: { requestId: 'test', items: [] }, tools: runtime, model });
  assert.equal(result.taskStatus, 'failed');
});

test('invalid tool arguments return an observation instead of crashing the loop', async () => {
  const { runtime, received } = fixture();
  const model: ChatModel = { kind: 'test', name: 'bad-json', async complete() {
    const message = call('read_material', {}); message.tool_calls![0]!.function.arguments = '{broken'; return message;
  } };
  const result = await runAgent({ request: { requestId: 'test', items: [] }, tools: runtime, model, maxSteps: 1 });
  assert.equal(result.taskStatus, 'incomplete');
  assert.match(JSON.stringify(result.trace), /INVALID_ARGUMENTS/);
  assert.equal(received.length, 0);
});
