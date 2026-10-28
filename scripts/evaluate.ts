import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { catalogSchema, requestSchema, type Catalog, type Draft, type ItemResult, type ScheduleRequest } from '../src/domain.js';
import { SchedulingTools } from '../src/tools.js';
import { DraftStore } from '../src/store.js';
import { runAgent, type AgentReport } from '../src/agent.js';
import { createModel } from '../src/config.js';

const { values } = parseArgs({ options: { model: { type: 'string', default: 'mock' }, out: { type: 'string' } } });
if (!['mock', 'live'].includes(values.model)) throw new Error('--model must be mock or live');
const mode = values.model as 'mock' | 'live';
const startedAt = new Date().toISOString();
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts'], { encoding: 'utf8' }).trim());
const out = values.out ?? `examples/${mode}`;
const databaseRoot = `.runtime/evaluation-${mode}-${Date.now()}`;
await mkdir(databaseRoot, { recursive: true });
await mkdir(out, { recursive: true });
const baseCatalog = catalogSchema.parse(JSON.parse(await readFile('data/catalog.json', 'utf8')));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = async (name: string, value: unknown) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');
interface Scenario {
  name: string; input: string; expected: AgentReport['taskStatus']; db?: string;
  mutate?: (catalog: Catalog) => void; failures?: Record<string, number>; maxSteps?: number;
  verify?: (report: AgentReport<ItemResult>, drafts: Draft[]) => void;
}
let normalDraftId = '', pendingDraftId = '';
const scenarios: Scenario[] = [
  { name: 'normal', input: 'normal', expected: 'completed', db: 'normal', verify: (r, drafts) => {
    assert.equal(drafts.length, 1); assert.equal(r.items[0]?.draft?.status, 'confirmed');
    assert.equal(r.items[0]?.suggestedAt, r.items[0]?.requestedAt); normalDraftId = drafts[0]!.id;
  } },
  { name: 'duplicate', input: 'normal', expected: 'completed', db: 'normal', verify: (r, drafts) => {
    assert.equal(drafts.length, 1); assert.equal(drafts[0]!.id, normalDraftId);
    assert.ok(r.trace.some(t => (t.observation as { data?: { duplicate?: boolean } }).data?.duplicate));
  } },
  { name: 'conflict', input: 'conflict', expected: 'needs_confirmation', db: 'conflict', verify: (r, drafts) => {
    assert.equal(drafts.length, 1); assert.equal(drafts[0]?.status, 'pending_confirmation');
    assert.notEqual(drafts[0]?.suggestedAt, drafts[0]?.requestedAt);
    assert.ok(r.items[0]?.pendingConfirmations.length); pendingDraftId = drafts[0]!.id;
  } },
  { name: 'confirmed', input: 'confirmed', expected: 'completed', db: 'conflict', verify: (_r, drafts) => {
    assert.equal(drafts.length, 1); assert.equal(drafts[0]?.id, pendingDraftId); assert.equal(drafts[0]?.status, 'confirmed');
    assert.equal(new Date(drafts[0]!.suggestedAt).toISOString(), '2026-11-01T11:00:00.000Z');
  } },
  { name: 'changed-occupancy', input: 'conflict', expected: 'completed', mutate: catalog => {
    catalog.occupied = [{ materialId: 'M00', channel: 'douyin', at: '2026-11-01T19:00:00+08:00' }];
  }, verify: (r, drafts) => { assert.equal(drafts.length, 1); assert.equal(r.items[0]?.suggestedAt, r.items[0]?.requestedAt); } },
  { name: 'missing', input: 'missing', expected: 'needs_input', verify: (r, drafts) => {
    assert.equal(drafts.length, 0); assert.ok(r.items[0]?.missingFields.includes('rights'));
  } },
  { name: 'risk', input: 'risk', expected: 'blocked', verify: (r, drafts) => {
    assert.equal(drafts.length, 0); assert.ok(r.items[0]?.risks.some(risk => risk.ruleId === 'R01' && risk.evidence.includes('100%有效')));
  } },
  { name: 'save-failure', input: 'save-failure', expected: 'failed', failures: { save_draft: 100 }, verify: (r, drafts) => {
    assert.equal(drafts.length, 0); assert.equal(r.items[0]?.saveStatus, 'failed');
    assert.ok(r.trace.some(t => (t.observation as { error?: { code?: string } }).error?.code === 'INJECTED_FAILURE'));
  } },
  { name: 'multi', input: 'multi', expected: 'blocked', verify: (r, drafts) => {
    assert.equal(drafts.length, 1); assert.equal(r.items.find(item => item.materialId === 'M01')?.saveStatus, 'saved');
    assert.equal(r.items.find(item => item.materialId === 'M02')?.status, 'needs_input');
    assert.equal(r.items.find(item => item.materialId === 'M03')?.status, 'blocked');
  } },
  { name: 'no-slots', input: 'conflict', expected: 'needs_input', mutate: catalog => {
    catalog.occupied = catalog.candidateSlots.map(at => ({ materialId: 'M00', channel: 'douyin', at }));
  }, verify: (_r, drafts) => assert.equal(drafts.length, 0) },
  { name: 'step-limit', input: 'normal', expected: 'incomplete', maxSteps: 1,
    verify: r => assert.equal(r.stopReason, 'MAX_STEPS') },
];

const results: Array<{ name: string; expected: string; actual: string; passed: boolean; modelSteps: number; toolCalls: number; draftCount: number; error?: string }> = [];
for (const scenario of scenarios) {
  const request: ScheduleRequest = requestSchema.parse(JSON.parse(await readFile(`examples/inputs/${scenario.input}.json`, 'utf8')));
  const catalog = structuredClone(baseCatalog); scenario.mutate?.(catalog);
  const store = new DraftStore(join(databaseRoot, `${scenario.db ?? scenario.name}.sqlite`));
  try {
    const model = createModel(mode);
    const report = await runAgent({ request, model, tools: new SchedulingTools({ request, catalog, store, failures: scenario.failures }), maxSteps: scenario.maxSteps });
    const drafts = store.list();
    let error: string | undefined;
    try { assert.equal(report.taskStatus, scenario.expected); scenario.verify?.(report, drafts); }
    catch (failure) { error = failure instanceof Error ? failure.message : 'Expectation failed'; }
    const { trace, ...output } = report;
    await json(`${scenario.name}.input.json`, request);
    await json(`${scenario.name}.catalog.json`, catalog);
    await json(`${scenario.name}.output.json`, output);
    await json(`${scenario.name}.trace.json`, trace);
    await json(`${scenario.name}.audit.json`, { expected: scenario.expected, passed: !error, error,
      faults: scenario.failures ?? {}, maxSteps: scenario.maxSteps ?? 16, draftCount: drafts.length, drafts,
      inputSha256: hash(request), catalogSha256: hash(catalog), databaseGroup: scenario.db ?? scenario.name });
    results.push({ name: scenario.name, expected: scenario.expected, actual: report.taskStatus, passed: !error,
      modelSteps: report.model.steps, toolCalls: report.toolCalls, draftCount: drafts.length, ...(error ? { error } : {}) });
    console.log(`${scenario.name}: ${report.taskStatus} (${error ? 'FAIL' : 'PASS'}), ${report.model.steps} model steps, ${drafts.length} drafts`);
  } finally { store.close(); }
}
const passed = results.filter(result => result.passed).length;
await json('summary.json', { mode, model: mode === 'live' ? process.env.OPENAI_MODEL : 'deterministic-offline-mock',
  sourceCommit, sourceDirty, startedAt, finishedAt: new Date().toISOString(), cases: results.length, passed, failed: results.length - passed, results,
  evidenceBoundary: mode === 'mock' ? 'Offline mock validates execution plumbing only; not real model decisions.' : 'Actual provider tool calls with synthetic local business tools. This is a small fixed test set, not a general success-rate estimate.' });
await writeFile(join(out, 'summary.md'), `# ${mode} 实际运行结果\n\n开始：${startedAt}\n\n${passed}/${results.length} 用例通过。${mode === 'mock' ? '离线 Mock 仅验证流程，不证明真实模型决策。' : '真实模型调用；所有业务资料为合成数据。'}\n\n| 用例 | 预期 | 实际 | 通过 | 步数 | 草稿数 |\n|---|---|---|---|---:|---:|\n` + results.map(r => `| [${r.name}](${r.name}.trace.json) | ${r.expected} | ${r.actual} | ${r.passed} | ${r.modelSteps} | ${r.draftCount} |`).join('\n') + '\n');
if (passed !== results.length) process.exitCode = 1;
