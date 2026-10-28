/** Minimal tool-call protocol adapted from the candidate's AckemCode design. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatModel {
  readonly kind: 'live' | 'mock' | 'test';
  readonly name: string;
  readonly attempts?: number;
  complete(messages: Message[], tools: ToolDefinition[]): Promise<Message>;
}
