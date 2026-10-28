import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, OPENAI_API_KEY: '' } });
}

test('CLI runs offline without credentials, persists one draft across process replays and writes a report', () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-cli-'));
  try {
    const output = join(root, 'result.json');
    const args = ['--input', 'examples/inputs/normal.json', '--model', 'mock', '--db', join(root, 'drafts.sqlite'), '--output', output];
    const first = cli(args), second = cli(args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const a = JSON.parse(first.stdout), b = JSON.parse(second.stdout);
    assert.equal(a.taskStatus, 'completed');
    assert.equal(a.model.kind, 'mock');
    assert.equal(a.items[0].draft.id, b.items[0].draft.id);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).taskStatus, 'completed');
    assert.ok(b.trace.some((entry: { observation: { data?: { duplicate?: boolean } } }) => entry.observation.data?.duplicate));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI uses explicit exit codes and structured statuses for missing data and save failure', () => {
  for (const [file, status, exitCode, extra] of [['missing', 'needs_input', 2, []], ['save-failure', 'failed', 1, ['--fail-save', '100']]] as const) {
    const result = cli(['--input', `examples/inputs/${file}.json`, '--db', ':memory:', ...extra]);
    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(JSON.parse(result.stdout).taskStatus, status);
  }
});

test('CLI rejects invalid flags and missing model credentials without leaking secrets', () => {
  const invalid = cli(['--bogus']);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).taskStatus, 'needs_input');
  const live = cli(['--model', 'live', '--input', 'examples/inputs/normal.json', '--db', ':memory:']);
  assert.equal(live.status, 1);
  assert.equal(JSON.parse(live.stdout).taskStatus, 'failed');
  assert.doesNotMatch(live.stdout, /sk-/);
});

test('report file failure preserves the truthful durable business result on stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-report-'));
  try {
    const badOutput = join(root, 'directory.json'); mkdirSync(badOutput);
    const result = cli(['--input', 'examples/inputs/normal.json', '--db', join(root, 'drafts.sqlite'), '--output', badOutput]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.taskStatus, 'completed');
    assert.equal(report.items[0].saveStatus, 'saved');
    assert.equal(report.artifactError.code, 'REPORT_WRITE_FAILED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI cannot overwrite an input through a hardlink or Windows case alias', () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-alias-'));
  try {
    const input = join(root, 'input.json'), alias = join(root, 'alias.json');
    const original = readFileSync('examples/inputs/normal.json', 'utf8');
    writeFileSync(input, original); linkSync(input, alias);
    const outputs = process.platform === 'win32' ? [alias, join(root, 'INPUT.json')] : [alias];
    for (const output of outputs) {
      const result = cli(['--input', input, '--db', ':memory:', '--output', output]);
      assert.equal(result.status, 2);
      assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_OUTPUT');
      assert.equal(readFileSync(input, 'utf8'), original);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
