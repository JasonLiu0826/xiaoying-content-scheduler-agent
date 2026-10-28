import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('assessment delivery documents and safe local configuration exist', () => {
  for (const file of ['README.md', '.env.example', 'docs/01-requirements.md',
    'docs/02-solution.md', 'docs/03-evaluation.md', 'docs/04-ai-usage.md',
    'docs/05-retrospective.md', 'docs/06-development-plan.md']) {
    assert.ok(existsSync(file), file);
    assert.ok(readFileSync(file, 'utf8').trim().length > 20, file);
  }
  assert.match(readFileSync('.gitignore', 'utf8'), /^\.env$/m);
  assert.match(readFileSync('.env.example', 'utf8'), /^OPENAI_API_KEY=$/m);
});
