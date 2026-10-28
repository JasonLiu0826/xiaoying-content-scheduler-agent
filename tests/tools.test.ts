import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestSchema, catalogSchema, type Catalog, type ScheduleRequest } from '../src/domain.js';
import { DraftStore } from '../src/store.js';
import { SchedulingTools, type ToolResult } from '../src/tools.js';

const at18 = '2026-11-01T18:00:00+08:00';
const at19 = '2026-11-01T19:00:00+08:00';
const catalog = (): Catalog => ({ ...catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8'))), occupied: [] });
const request = (overrides: Record<string, unknown> = {}): ScheduleRequest => requestSchema.parse({
  requestId: 'request-1', items: [{ materialId: 'M01', channel: 'douyin', requestedAt: at18 }], ...overrides,
});
const args = (materialId = 'M01') => ({ materialId, reason: '验证排期条件' });
const save = (suggestedAt = at18, materialId = 'M01') => ({ ...args(materialId), suggestedAt });
function code(result: ToolResult) { assert.equal(result.ok, false); if (!result.ok) return result.error.code; return ''; }
async function prepare(tools: SchedulingTools, materialId = 'M01') {
  for (const name of ['read_material', 'check_rules', 'query_slots']) assert.equal((await tools.execute(name, args(materialId))).ok, true);
}
function setup(req = request(), cat = catalog(), failures?: Partial<Record<string, number>>) {
  const store = new DraftStore(':memory:');
  const tools = new SchedulingTools({ request: req, catalog: cat, store, failures });
  return { store, tools };
}

test('normal request saves approved original time with a durable receipt', async () => {
  const { store, tools } = setup();
  try {
    await prepare(tools);
    assert.equal((await tools.execute('save_draft', save())).ok, true);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.status, 'confirmed');
    assert.equal(tools.snapshot()[0]?.status, 'draft_saved');
    assert.equal(tools.snapshot()[0]?.requestedAt, at18);
  } finally { store.close(); }
});

test('missing metadata identifies fields and prevents saving', async () => {
  const { store, tools } = setup(request({ items: [{ materialId: 'M02', channel: 'douyin', requestedAt: at18 }] }));
  try {
    await prepare(tools, 'M02');
    const result = tools.snapshot()[0]!;
    assert.equal(result.reviewStatus, 'missing_info');
    assert.deepEqual(result.missingFields.sort(), ['rights', 'title']);
    assert.equal(code(await tools.execute('save_draft', save(at18, 'M02'))), 'REVIEW_NOT_APPROVED');
    assert.equal(tools.snapshot()[0]?.status, 'needs_input');
    assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test('rule risks include matching evidence and rule ID and cannot be bypassed', async () => {
  const { store, tools } = setup(request({ items: [{ materialId: 'M03', channel: 'douyin', requestedAt: at18 }] }));
  try {
    await prepare(tools, 'M03');
    const risk = tools.snapshot()[0]?.risks[0];
    assert.ok(risk?.ruleId);
    assert.match(risk?.evidence ?? '', /100%有效/);
    assert.equal(tools.snapshot()[0]?.status, 'blocked');
    assert.equal(code(await tools.execute('save_draft', save(at18, 'M03'))), 'REVIEW_NOT_APPROVED');
    assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test('unknown materials stay needs_input and cannot save', async () => {
  const { store, tools } = setup(request({ items: [{ materialId: 'unknown', channel: 'douyin', requestedAt: at18 }] }));
  try {
    assert.equal(code(await tools.execute('read_material', args('unknown'))), 'MATERIAL_NOT_FOUND');
    assert.equal(tools.snapshot()[0]?.status, 'needs_input');
    assert.equal(code(await tools.execute('save_draft', save(at18, 'unknown'))), 'PREREQUISITE_MISSING');
    assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test('occupied original time gives an alternative pending confirmation without reserving it', async () => {
  const cat = catalog(); cat.occupied.push({ materialId: 'old', channel: 'douyin', at: at18 });
  const { store, tools } = setup(request(), cat);
  try {
    await prepare(tools);
    const query = await tools.execute('query_slots', args());
    assert.ok(query.ok && 'requestedAvailable' in query.data && !query.data.requestedAvailable);
    assert.equal((await tools.execute('save_draft', save(at19))).ok, true);
    assert.equal(tools.snapshot()[0]?.status, 'needs_confirmation');
    assert.equal(store.list()[0]?.requestedAt, at18);
    assert.equal(store.list()[0]?.status, 'pending_confirmation');
    const next = new SchedulingTools({ store, catalog: cat, request: request({ requestId: 'next', items: [{ materialId: 'M01', channel: 'douyin', requestedAt: at19 }] }) });
    await prepare(next);
    assert.equal((await next.execute('save_draft', save(at19))).ok, true);
  } finally { store.close(); }
});

test('exact user confirmation accepts equivalent timestamp instants', async () => {
  const req = request({ confirmations: [{ materialId: 'M01', channel: 'douyin', requestedAt: '2026-11-01T10:00:00Z', suggestedAt: '2026-11-01T11:00:00Z' }] });
  const { store, tools } = setup(req);
  try { await prepare(tools); assert.equal((await tools.execute('save_draft', save(at19))).ok, true); assert.equal(store.list()[0]?.status, 'confirmed'); }
  finally { store.close(); }
});

test('forged confirmation and rewritten channel/time arguments are rejected', async () => {
  const { store, tools } = setup();
  try {
    await prepare(tools);
    for (const extra of [{ confirmed: true }, { channel: 'other' }, { requestedAt: at19 }]) {
      assert.equal(code(await tools.execute('save_draft', { ...save(at19), ...extra })), 'INVALID_TOOL_ARGS');
    }
    assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test('save requires successful read, review and slot query', async () => {
  const { store, tools } = setup();
  try {
    assert.equal(code(await tools.execute('save_draft', save())), 'PREREQUISITE_MISSING');
    await tools.execute('read_material', args()); await tools.execute('check_rules', args());
    assert.equal(code(await tools.execute('save_draft', save())), 'PREREQUISITE_MISSING');
  } finally { store.close(); }
});

test('confirmation must bind item, channel, original and suggestion exactly', async () => {
  for (const wrong of [{ channel: 'other' }, { materialId: 'M02' }, { requestedAt: at19 }, { suggestedAt: at18 }]) {
    const { store, tools } = setup(request({ confirmations: [{ materialId: 'M01', channel: 'douyin', requestedAt: at18, suggestedAt: at19, ...wrong }] }));
    try { await prepare(tools); await tools.execute('save_draft', save(at19)); assert.equal(store.list()[0]?.status, 'pending_confirmation'); }
    finally { store.close(); }
  }
});

test('non-hard time allows a confirmed alternative and off-catalog suggestions are rejected', async () => {
  const { store, tools } = setup(request({ items: [{ materialId: 'M01', channel: 'douyin', requestedAt: at18, hardTime: false }] }));
  try {
    await prepare(tools);
    assert.equal(code(await tools.execute('save_draft', save('2026-11-02T18:00:00+08:00'))), 'UNOBSERVED_SLOT');
    assert.equal((await tools.execute('save_draft', save(at19))).ok, true);
    assert.equal(store.list()[0]?.status, 'confirmed');
  } finally { store.close(); }
});

test('replay across reopen returns one stable ID and conflicting request input is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-')); const db = join(dir, 'drafts.sqlite');
  let store = new DraftStore(db);
  try {
    let tools = new SchedulingTools({ store, catalog: catalog(), request: request() });
    await prepare(tools); await tools.execute('save_draft', save()); const id = store.list()[0]!.id;
    store.close(); store = new DraftStore(db);
    tools = new SchedulingTools({ store, catalog: catalog(), request: request() });
    await prepare(tools); const replay = await tools.execute('save_draft', save());
    assert.ok(replay.ok && 'duplicate' in replay.data && replay.data.duplicate);
    assert.equal(store.list()[0]?.id, id); assert.equal(store.list().length, 1);
    const changed = new SchedulingTools({ store, catalog: catalog(), request: request({ items: [{ materialId: 'M01', channel: 'douyin', requestedAt: at19 }] }) });
    assert.equal(code(await changed.execute('read_material', args())), 'IDEMPOTENCY_CONFLICT');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('confirmation upgrades pending draft in place and replay cannot downgrade it', async () => {
  const { store, tools } = setup();
  try {
    await prepare(tools); await tools.execute('save_draft', save(at19)); const id = store.list()[0]!.id;
    const confirmed = new SchedulingTools({ store, catalog: catalog(), request: request({ confirmations: [{ materialId: 'M01', channel: 'douyin', requestedAt: at18, suggestedAt: at19 }] }) });
    await prepare(confirmed); await confirmed.execute('save_draft', save(at19));
    assert.equal(store.list().length, 1); assert.equal(store.list()[0]?.id, id); assert.equal(store.list()[0]?.status, 'confirmed');
    const replay = new SchedulingTools({ store, catalog: catalog(), request: request() });
    await prepare(replay); await replay.execute('save_draft', save(at19));
    assert.equal(store.list()[0]?.status, 'confirmed');
  } finally { store.close(); }
});

test('save fault inserts nothing and success recovery retains explicit failure history', async () => {
  const { store, tools } = setup(request(), catalog(), { save_draft: 1 });
  try {
    await prepare(tools);
    assert.equal(code(await tools.execute('save_draft', save())), 'INJECTED_FAILURE');
    assert.equal(store.list().length, 0); assert.equal(tools.snapshot()[0]?.status, 'failed');
    await tools.execute('save_draft', save());
    assert.equal(tools.snapshot()[0]?.status, 'draft_saved'); assert.equal(tools.snapshot()[0]?.errors.length, 1);
  } finally { store.close(); }
});

test('save rechecks occupied catalog entries after query', async () => {
  const cat = catalog(); const { store, tools } = setup(request(), cat);
  try {
    await prepare(tools); cat.occupied.push({ materialId: 'new', channel: 'douyin', at: at18 });
    assert.equal(code(await tools.execute('save_draft', save())), 'SLOT_CONFLICT');
    assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test('save rechecks review rules after earlier approval', async () => {
  const cat = catalog(); const { store, tools } = setup(request(), cat);
  try {
    await prepare(tools); cat.materials[0]!.description = '100%有效';
    assert.equal(code(await tools.execute('save_draft', save())), 'REVIEW_NOT_APPROVED');
    assert.equal(tools.snapshot()[0]?.status, 'blocked'); assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test('confirmed slot uniqueness works across connections and canonical timestamps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-race-')); const db = join(dir, 'drafts.sqlite');
  const first = new DraftStore(db); const second = new DraftStore(db);
  try {
    const a = new SchedulingTools({ store: first, catalog: catalog(), request: request() });
    const b = new SchedulingTools({ store: second, catalog: catalog(), request: request({ requestId: 'second', items: [{ materialId: 'M01', channel: 'douyin', requestedAt: '2026-11-01T10:00:00Z' }] }) });
    await prepare(a); await prepare(b);
    assert.equal((await a.execute('save_draft', save())).ok, true);
    assert.equal(code(await b.execute('save_draft', save('2026-11-01T10:00:00Z'))), 'SLOT_CONFLICT');
    assert.equal(first.list().length, 1);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('multiple items retain partial successful results', async () => {
  const { store, tools } = setup(request({ items: ['M01', 'M02', 'M03'].map(materialId => ({ materialId, channel: 'douyin', requestedAt: at18 })) }));
  try {
    for (const id of ['M01', 'M02', 'M03']) { await prepare(tools, id); await tools.execute('save_draft', save(at18, id)); }
    assert.deepEqual(tools.snapshot().map(item => item.status), ['draft_saved', 'needs_input', 'blocked']);
    assert.equal(store.list().length, 1);
  } finally { store.close(); }
});

test('unknown tool, unknown request item and invalid input return structured errors', async () => {
  const { store, tools } = setup();
  try {
    assert.equal(code(await tools.execute('publish', args())), 'UNKNOWN_TOOL');
    assert.equal(code(await tools.execute('read_material', args('M99'))), 'ITEM_NOT_REQUESTED');
    assert.equal(code(await tools.execute('read_material', { materialId: 'M01', reason: '' })), 'INVALID_TOOL_ARGS');
  } finally { store.close(); }
});

test('no available candidate slot is an explicit needs_input outcome and can recover after requery', async () => {
  const cat = catalog();
  cat.occupied = cat.candidateSlots.map(at => ({ materialId: 'occupied', channel: 'douyin', at }));
  const { store, tools } = setup(request(), cat);
  try {
    await prepare(tools);
    assert.equal(tools.snapshot()[0]?.status, 'needs_input');
    assert.ok(tools.snapshot()[0]!.pendingConfirmations.length > 0);
    cat.occupied = [];
    await tools.execute('query_slots', args());
    assert.equal(tools.snapshot()[0]?.status, 'pending');
  } finally { store.close(); }
});

test('user confirmation input cannot be changed by mutating the original request', async () => {
  const req = request(); const { store, tools } = setup(req);
  try {
    req.confirmations.push({ materialId: 'M01', channel: 'douyin', requestedAt: at18, suggestedAt: at19 });
    await prepare(tools); await tools.execute('save_draft', save(at19));
    assert.equal(store.list()[0]?.status, 'pending_confirmation');
  } finally { store.close(); }
});

test('read/check/query failure is explicit and retry recovery preserves history', async () => {
  for (const name of ['read_material', 'check_rules', 'query_slots']) {
    const { store, tools } = setup(request(), catalog(), { [name]: 1 });
    try {
      assert.equal(code(await tools.execute(name, args())), 'INJECTED_FAILURE');
      assert.equal(tools.snapshot()[0]?.status, 'failed');
      assert.equal((await tools.execute(name, args())).ok, true);
      assert.equal(tools.snapshot()[0]?.status, 'pending');
      assert.equal(tools.snapshot()[0]?.errors.length, 1);
    } finally { store.close(); }
  }
});

test('manual-review rule cannot save and includes reason in pending confirmations', async () => {
  const cat = catalog(); cat.materials[0]!.description = '宣称行业第一';
  const { store, tools } = setup(request(), cat);
  try {
    await prepare(tools);
    assert.equal(tools.snapshot()[0]?.status, 'needs_input');
    assert.match(tools.snapshot()[0]?.pendingConfirmations[0] ?? '', /R02/);
    assert.equal(code(await tools.execute('save_draft', save())), 'REVIEW_NOT_APPROVED');
    assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test('rechecking rules preserves outstanding consent on a pending draft', async () => {
  const { store, tools } = setup();
  try {
    await prepare(tools); await tools.execute('save_draft', save(at19));
    await tools.execute('check_rules', args());
    assert.equal(tools.snapshot()[0]?.status, 'needs_confirmation');
    assert.ok(tools.snapshot()[0]!.pendingConfirmations.length > 0);
  } finally { store.close(); }
});

test('database uniqueness constraint protects confirmed times even with a raw second writer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-constraint-')); const db = join(dir, 'drafts.sqlite');
  const store = new DraftStore(db);
  try {
    const tools = new SchedulingTools({ store, catalog: catalog(), request: request() });
    await prepare(tools); await tools.execute('save_draft', save());
    const { DatabaseSync } = await import('node:sqlite'); const second = new DatabaseSync(db);
    try {
      assert.throws(() => second.prepare(`INSERT INTO drafts(id, request_id, materialId, channel, requestedAt, suggestedAt, instant, status)
        VALUES ('forged', 'request-1', 'M02', 'douyin', ?, ?, ?, 'confirmed')`)
        .run(at18, at18, '2026-11-01T10:00:00.000Z'), /UNIQUE constraint failed/);
    } finally { second.close(); }
    assert.equal(store.list().length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('confirmed draft replay cannot silently return a different unvalidated suggestion', async () => {
  const cat = catalog(); const { store, tools } = setup(request(), cat);
  try {
    await prepare(tools); await tools.execute('save_draft', save());
    const id = store.list()[0]!.id;
    cat.occupied.push({ materialId: 'new', channel: 'douyin', at: at18 });
    await tools.execute('query_slots', args());
    assert.equal(code(await tools.execute('save_draft', save(at19))), 'DRAFT_ALREADY_CONFIRMED');
    assert.equal(store.list()[0]?.id, id);
    assert.equal(store.list()[0]?.suggestedAt, at18);
    assert.equal(store.list().length, 1);
  } finally { store.close(); }
});
