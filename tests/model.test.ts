import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleModel, ModelError } from '../src/model.js';

const config = { baseUrl: 'https://provider.test/v1', apiKey: 'sk-test-secret', model: 'test-model', timeoutMs: 1000, maxRetries: 1 };
const tools = [{ type: 'function' as const, function: { name: 'read_material', description: 'read', parameters: { type: 'object' } } }];
const messages = [{ role: 'user' as const, content: '审核 M01' }];
const reply = { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_material', arguments: '{"materialId":"M01","reason":"先读取素材"}' } }] } }] };

test('sends tools and full observed history to configurable compatible endpoint', async () => {
  let requestBody: Record<string, unknown> = {};
  const model = new OpenAICompatibleModel(config, async (url, init) => {
    assert.equal(url, 'https://provider.test/v1/chat/completions');
    requestBody = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk-test-secret');
    return Response.json(reply);
  });
  const response = await model.complete(messages, tools);
  assert.equal(response.tool_calls?.[0]?.function.name, 'read_material');
  assert.deepEqual(requestBody.messages, messages);
  assert.deepEqual(requestBody.tools, tools);
});

test('retries transient HTTP failure a finite number of times', async () => {
  let attempts = 0;
  const model = new OpenAICompatibleModel({ ...config, retryDelayMs: 0 }, async () => {
    attempts++;
    return attempts === 1 ? new Response('unavailable', { status: 503 }) : Response.json(reply);
  });
  await model.complete(messages, tools);
  assert.equal(attempts, 2);
  assert.equal(model.attempts, 2);
});

test('authentication errors do not retry or leak provider bodies and credentials', async () => {
  let attempts = 0;
  const model = new OpenAICompatibleModel(config, async () => { attempts++; return new Response('sk-test-secret provider details', { status: 401 }); });
  await assert.rejects(model.complete(messages, tools), (error: unknown) => {
    assert.ok(error instanceof ModelError);
    assert.equal(error.code, 'MODEL_HTTP_401');
    assert.doesNotMatch(error.message, /sk-test-secret|provider details/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('rejects truncated or malformed completions before any business execution', async () => {
  for (const body of [{ choices: [] }, { choices: [{ message: { content: null }, finish_reason: 'length' }] }, { choices: [{ message: { content: null, tool_calls: [{ id: '', function: {} }] } }] }]) {
    const model = new OpenAICompatibleModel(config, async () => Response.json(body));
    await assert.rejects(model.complete(messages, tools), ModelError);
  }
});

test('times out a stalled provider and stops after the configured budget', async () => {
  const model = new OpenAICompatibleModel({ ...config, timeoutMs: 20, maxRetries: 0 }, async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('unexpected timeout fallback')), 1000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
    });
  });
  await assert.rejects(model.complete(messages, tools), (error: unknown) => error instanceof ModelError && error.code === 'MODEL_TIMEOUT');
});

test('rejects an entire batch when any call contains invalid JSON arguments', async () => {
  const body = structuredClone(reply);
  body.choices[0]!.message.tool_calls.push({ id: 'bad', type: 'function', function: { name: 'save_draft', arguments: '{invalid' } });
  const model = new OpenAICompatibleModel(config, async () => Response.json(body));
  await assert.rejects(model.complete(messages, tools), (error: unknown) => error instanceof ModelError && error.code === 'MODEL_INVALID_RESPONSE');
});

test('disables credential-bearing HTTP redirects', async () => {
  const model = new OpenAICompatibleModel(config, async (_url, init) => {
    assert.equal(init?.redirect, 'error');
    return Response.json(reply);
  });
  await model.complete(messages, tools);
});

test('retries transient response-body disconnects but does not retry invalid JSON', async () => {
  let attempts = 0;
  const model = new OpenAICompatibleModel({ ...config, retryDelayMs: 0 }, async () => {
    attempts++;
    return attempts === 1 ? { ok: true, async json() { throw new TypeError('terminated'); } } as unknown as Response : Response.json(reply);
  });
  await model.complete(messages, tools);
  assert.equal(attempts, 2);
  let invalidAttempts = 0;
  const invalid = new OpenAICompatibleModel(config, async () => { invalidAttempts++; return new Response('{invalid'); });
  await assert.rejects(invalid.complete(messages, tools), (error: unknown) => error instanceof ModelError && error.code === 'MODEL_INVALID_RESPONSE');
  assert.equal(invalidAttempts, 1);
});
