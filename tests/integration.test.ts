import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestSchema, catalogSchema } from '../src/domain.js';
import { DraftStore } from '../src/store.js';
import { SchedulingTools } from '../src/tools.js';
import { runAgent } from '../src/agent.js';
import { OfflineMockModel } from '../src/mock-model.js';

const catalog = catalogSchema.parse(JSON.parse(readFileSync('data/catalog.json', 'utf8')));
for (const [name, expected] of [['normal', 'completed'], ['conflict', 'needs_confirmation'], ['missing', 'needs_input'], ['risk', 'blocked'], ['save-failure', 'failed'], ['multi', 'blocked']] as const) {
  test(`offline end-to-end ${name} uses real tools and reports ${expected}`, async () => {
    const request = requestSchema.parse(JSON.parse(readFileSync(`examples/inputs/${name}.json`, 'utf8')));
    const store = new DraftStore(':memory:');
    try {
      const tools = new SchedulingTools({ request, catalog, store, failures: name === 'save-failure' ? { save_draft: 100 } : {} });
      const result = await runAgent({ request, tools, model: new OfflineMockModel() });
      assert.equal(result.taskStatus, expected);
      assert.equal(result.model.kind, 'mock');
      assert.equal(result.stopReason, 'MODEL_FINISHED');
      if (name === 'save-failure' || name === 'missing' || name === 'risk') assert.equal(store.list().length, 0);
      if (name === 'multi') assert.equal(store.list().length, 1);
      if (name === 'conflict') {
        assert.equal(store.list()[0]?.status, 'pending_confirmation');
        assert.equal(store.list()[0]?.requestedAt, '2026-11-01T18:00:00+08:00');
      }
    } finally { store.close(); }
  });
}

test('a pending draft can be confirmed on replay without creating a duplicate', async () => {
  const store = new DraftStore(':memory:');
  try {
    for (const name of ['conflict', 'confirmed']) {
      const request = requestSchema.parse(JSON.parse(readFileSync(`examples/inputs/${name}.json`, 'utf8')));
      await runAgent({ request, tools: new SchedulingTools({ request, catalog, store }), model: new OfflineMockModel() });
    }
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.status, 'confirmed');
  } finally { store.close(); }
});
