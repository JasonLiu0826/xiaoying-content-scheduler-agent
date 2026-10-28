import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestSchema, catalogSchema, timestampSchema } from '../src/domain.js';

const at = '2026-11-01T18:00:00+08:00';
const item = { materialId: 'M01', channel: 'douyin', requestedAt: at };

test('request defaults hardTime and accepts timestamps with explicit offsets', () => {
  assert.equal(requestSchema.parse({ requestId: 'r', items: [item] }).items[0]?.hardTime, true);
  assert.ok(requestSchema.safeParse({ requestId: 'r', items: [{ ...item, requestedAt: '2026-11-01T10:00:00Z' }] }).success);
});

test('request rejects absent offsets, impossible dates, duplicate material IDs and unknown fields', () => {
  for (const requestedAt of ['2026-11-01T18:00:00', '2026-02-30T18:00:00+08:00', '2026-11-01T25:00:00+08:00', 'garbage']) {
    assert.equal(requestSchema.safeParse({ requestId: 'r', items: [{ ...item, requestedAt }] }).success, false, requestedAt);
  }
  assert.equal(requestSchema.safeParse({ requestId: 'r', items: [item, item] }).success, false);
  assert.equal(requestSchema.safeParse({ requestId: 'r', items: [{ ...item, confirmed: true }] }).success, false);
  assert.equal(requestSchema.safeParse({ requestId: '', items: [] }).success, false);
});

test('confirmation and catalog timestamps receive the same strict validation', () => {
  assert.equal(requestSchema.safeParse({ requestId: 'r', items: [item], confirmations: [{ ...item, suggestedAt: 'tomorrow' }] }).success, false);
  assert.equal(catalogSchema.safeParse({ materials: [], rules: [], occupied: [], candidateSlots: ['2026-02-30T10:00:00Z'] }).success, false);
});

test('whole seconds and up to three fractional digits are represented without precision loss', () => {
  for (const suffix of ['', '.1', '.12', '.123']) {
    for (const offset of ['Z', '+08:00']) {
      assert.equal(timestampSchema.safeParse(`2026-11-01T18:00:00${suffix}${offset}`).success, true);
    }
  }
});

test('submillisecond precision is rejected in request, confirmation and every catalog timestamp', () => {
  for (const suffix of ['.0001', '.0009', '.123456789']) {
    for (const offset of ['Z', '+08:00']) {
      const unsupported = `2026-11-01T18:00:00${suffix}${offset}`;
      assert.equal(requestSchema.safeParse({ requestId: 'r', items: [{ ...item, requestedAt: unsupported }] }).success, false, unsupported);
      for (const field of ['requestedAt', 'suggestedAt']) {
        assert.equal(requestSchema.safeParse({ requestId: 'r', items: [item],
          confirmations: [{ ...item, suggestedAt: at, [field]: unsupported }] }).success, false, field);
      }
      assert.equal(catalogSchema.safeParse({ materials: [], rules: [], occupied: [], candidateSlots: [unsupported] }).success, false);
      assert.equal(catalogSchema.safeParse({ materials: [], rules: [], candidateSlots: [],
        occupied: [{ materialId: 'M00', channel: 'douyin', at: unsupported }] }).success, false);
    }
  }
});
