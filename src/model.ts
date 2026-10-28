import type { ChatModel, Message, ToolDefinition } from './protocol.js';
import { z } from 'zod';

export class ModelError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ModelError'; }
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs?: number;
}

const completionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string().min(1),
        type: z.literal('function'),
        function: z.object({ name: z.string().min(1), arguments: z.string() }),
      })).max(8).optional(),
    }),
  })).min(1),
});

function decodeCompletion(body: unknown): Message {
  const parsed = completionSchema.safeParse(body);
  if (!parsed.success) throw new ModelError('MODEL_INVALID_RESPONSE', '模型返回的工具调用格式不合法');
  const choice = parsed.data.choices[0]!;
  if (choice.finish_reason === 'length') throw new ModelError('MODEL_OUTPUT_TRUNCATED', '模型输出被截断，未执行该轮动作');
  const calls = choice.message.tool_calls;
  if (calls && new Set(calls.map(call => call.id)).size !== calls.length) {
    throw new ModelError('MODEL_INVALID_RESPONSE', '模型返回重复的工具调用 ID');
  }
  for (const call of calls ?? []) {
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw new ModelError('MODEL_INVALID_RESPONSE', '模型返回了无效的工具参数 JSON，未执行该轮动作'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new ModelError('MODEL_INVALID_RESPONSE', '模型工具参数必须是 JSON 对象');
    }
  }
  return { role: 'assistant', content: choice.message.content ?? null, ...(calls?.length ? { tool_calls: calls } : {}) };
}

export class OpenAICompatibleModel implements ChatModel {
  readonly kind = 'live' as const;
  readonly name: string;
  attempts = 0;
  constructor(private readonly config: ModelConfig, private readonly fetcher: typeof fetch = fetch) {
    this.name = config.model;
    const url = new URL(config.baseUrl);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new ModelError('MODEL_CONFIG', '模型地址须使用 HTTPS（本机测试可使用 HTTP），且不可含凭据或查询参数');
    }
    if (!config.apiKey.trim() || !config.model.trim() || !Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 3 ||
      !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120000) {
      throw new ModelError('MODEL_CONFIG', '模型名称、密钥、超时或重试配置不合法');
    }
  }

  async complete(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const signal = AbortSignal.timeout(this.config.timeoutMs);
      let retryable = false;
      try {
        this.attempts++;
        const response = await this.fetcher(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
          body: JSON.stringify({ model: this.name, messages, tools, tool_choice: 'auto', temperature: 0,
            max_tokens: 2048, ...(this.name.startsWith('deepseek-') ? { thinking: { type: 'disabled' } } : {}) }),
          signal,
        });
        if (!response.ok) {
          retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          await response.body?.cancel();
          throw new ModelError(`MODEL_HTTP_${response.status}`, `模型接口返回 HTTP ${response.status}`);
        }
        let body: unknown;
        try { body = await response.json(); }
        catch (error) {
          if (error instanceof SyntaxError) throw new ModelError('MODEL_INVALID_RESPONSE', '模型接口未返回有效 JSON');
          throw error;
        }
        return decodeCompletion(body);
      } catch (error) {
        const safeError = signal.aborted
          ? new ModelError('MODEL_TIMEOUT', '模型请求超时')
          : error instanceof ModelError ? error : new ModelError('MODEL_NETWORK', '模型网络请求失败');
        retryable ||= safeError.code === 'MODEL_TIMEOUT' || safeError.code === 'MODEL_NETWORK';
        if (!retryable || attempt === this.config.maxRetries) throw safeError;
        await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs ?? 250 * (attempt + 1)));
      }
    }
    throw new ModelError('MODEL_FAILED', '模型调用未完成');
  }
}
