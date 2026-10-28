import { OpenAICompatibleModel } from './model.js';
import { OfflineMockModel } from './mock-model.js';
import type { ChatModel } from './protocol.js';

export function createModel(mode: 'live' | 'mock'): ChatModel {
  if (mode === 'mock') return new OfflineMockModel();
  return new OpenAICompatibleModel({
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || '',
    apiKey: process.env.OPENAI_API_KEY || '',
    timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 30000),
    maxRetries: Number(process.env.MODEL_MAX_RETRIES || 1),
  });
}
