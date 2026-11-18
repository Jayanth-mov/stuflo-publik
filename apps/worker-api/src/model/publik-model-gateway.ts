import { ModelProviderError } from './model-gateway';
import type {
  ModelCompletion,
  ModelCompletionInput,
  ModelGateway,
  ModelToolCall,
} from './model-gateway';

export const PUBLIK_ORIGIN = 'https://publikhq.com';
export const PUBLIK_MODELS = ['publik-fast', 'publik-balanced', 'publik-smart'] as const;
export type PublikModelTier = typeof PUBLIK_MODELS[number];
const MAX_REQUEST_BYTES = 4_000_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function publikLink(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) return null;
  try {
    const url = new URL(value, PUBLIK_ORIGIN);
    return url.origin === PUBLIK_ORIGIN && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function readablePaymentMessage(value: unknown): string {
  if (typeof value !== 'string') return 'Not enough Publik API balance.';
  const sanitized = value
    .replace(/[\[\]<>]/g, '')
    .replace(/\b(?:pat|pk|pbt|sk)_[A-Za-z0-9_-]+\b/gi, '[redacted]')
    .replace(/\b(?:https?:\/\/|www\.|mailto:)\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  return sanitized || 'Not enough Publik API balance.';
}

export class PublikPaymentRequiredError extends ModelProviderError {
  readonly topUpUrl: string | null;

  constructor(message: unknown, topUpUrl: unknown) {
    super(402, 'publik_payment_required', readablePaymentMessage(message));
    this.name = 'PublikPaymentRequiredError';
    this.topUpUrl = publikLink(topUpUrl);
  }
}

export class PublikInputError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string, message: string) {
    super(message);
    this.name = 'PublikInputError';
  }
}

interface PublikModelGatewayOptions {
  apiKey: string;
  model: PublikModelTier;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

function tooLarge(): PublikInputError {
  return new PublikInputError(413, 'publik_input_too_large', 'Publik requests must be under 4 MB. Try a smaller image or a more focused request.');
}

function makeBody(model: PublikModelTier, input: ModelCompletionInput): string {
  const items: Array<Record<string, unknown>> = [];
  let encodedFileBytes = 0;
  for (const message of input.messages) {
    if (message.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' });
      continue;
    }
    if (message.content || message.inputFiles?.length) {
      const files = (message.inputFiles ?? []).map((file) => {
        if (!IMAGE_TYPES.has(file.mimeType)) {
          throw new PublikInputError(400, 'publik_unsupported_file', 'Publik chat currently supports image files only. Paste the relevant document text to continue.');
        }
        encodedFileBytes += file.base64Data.length;
        if (encodedFileBytes >= MAX_REQUEST_BYTES) throw tooLarge();
        return { type: 'input_image', image_url: `data:${file.mimeType};base64,${file.base64Data}`, detail: file.detail ?? 'auto' };
      });
      items.push({
        role: message.role === 'system' ? 'developer' : message.role,
        content: files.length
          ? [...(message.content ? [{ type: 'input_text', text: message.content }] : []), ...files]
          : message.content,
      });
    }
    for (const call of message.tool_calls ?? []) {
      items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  const tools = input.tools?.map(({ function: tool }) => ({ type: 'function', ...tool, strict: false }));
  const body = JSON.stringify({
    model,
    input: items,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    max_output_tokens: 3_000,
    store: false,
    stream: true,
  });
  if (body.length >= MAX_REQUEST_BYTES || new TextEncoder().encode(body).length >= MAX_REQUEST_BYTES) throw tooLarge();
  return body;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function upstreamError(code: string, message = 'Publik could not complete the request. Please try again.'): ModelProviderError {
  return new ModelProviderError(502, code, message);
}

function completion(payload: JsonObject, streamText: string, tier: PublikModelTier, started: number): ModelCompletion {
  if (payload.status === 'incomplete') {
    throw upstreamError('publik_response_incomplete', 'The Publik reply ended before it finished. Try a shorter or more focused request.');
  }
  if (payload.status === 'failed' || !Array.isArray(payload.output)) {
    throw upstreamError('publik_invalid_response');
  }
  const content: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  for (const wireItem of payload.output) {
    const item = object(wireItem);
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const wirePart of item.content) {
        const part = object(wirePart);
        if (part.type === 'output_text' && typeof part.text === 'string') content.push(part.text);
        if (part.type === 'refusal' && typeof part.refusal === 'string') content.push(part.refusal);
      }
    }
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name || typeof item.arguments !== 'string') {
        throw upstreamError('publik_invalid_tool_call');
      }
      toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    }
  }
  const text = content.join('') || streamText;
  if (!text && toolCalls.length === 0) throw upstreamError('publik_empty_response');
  const usage = object(payload.usage);
  const details = object(usage.input_tokens_details);
  const reportedModel = typeof payload.model === 'string' && /^[a-z\d_.:/-]{1,120}$/i.test(payload.model) ? payload.model : tier;
  return {
    content: text,
    toolCalls,
    provider: 'publik',
    model: reportedModel,
    usage: {
      inputTokens: tokens(usage.input_tokens),
      outputTokens: tokens(usage.output_tokens),
      cachedInputTokens: tokens(details.cached_tokens),
      cacheWriteInputTokens: tokens(details.cache_write_tokens),
    },
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

async function consumeResponsesStream(response: Response, input: ModelCompletionInput, tier: PublikModelTier, started: number): Promise<ModelCompletion> {
  const reader = response.body?.getReader();
  if (!reader) throw upstreamError('publik_missing_stream');
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  let streamText = '';
  const state: { completion?: ModelCompletion; done: boolean } = { done: false };

  const consume = async (packet: string) => {
    const data = packet.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data === '[DONE]') state.done = true;
    if (!data || state.done || state.completion) return;
    let event: JsonObject;
    try { event = object(JSON.parse(data)); } catch { throw upstreamError('publik_invalid_stream'); }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      streamText += event.delta;
      await input.onTextDelta?.(event.delta);
    }
    if (event.type === 'response.completed') state.completion = completion(object(event.response), streamText, tier, started);
    if (event.type === 'response.incomplete') throw upstreamError('publik_response_incomplete', 'The Publik reply ended before it finished. Try a shorter or more focused request.');
    if (event.type === 'response.failed' || event.type === 'error' || event.error) throw upstreamError('publik_stream_failed');
  };

  try {
    while (!state.done) {
      const { value, done } = await reader.read();
      received += value?.byteLength ?? 0;
      if (received > MAX_RESPONSE_BYTES) throw upstreamError('publik_response_too_large');
      // Normalize CRLF only after joining reads so a delimiter can span chunks.
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1 && !state.done) {
        await consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
      if (done) {
        if (buffer.trim()) await consume(buffer);
        break;
      }
    }
    const finished = state.completion;
    if (!finished) throw upstreamError('publik_stream_ended', 'The Publik connection ended before the reply finished.');
    if (finished.content.startsWith(streamText)) {
      const remainder = finished.content.slice(streamText.length);
      if (remainder) await input.onTextDelta?.(remainder);
    }
    return finished;
  } finally {
    // Do not keep reading after the final event or an error.
    void reader.cancel().catch(() => undefined);
  }
}

/** Each gateway instance uses only the signed-in person's install key. */
export class PublikModelGateway implements ModelGateway {
  constructor(private readonly options: PublikModelGatewayOptions) {
    if (!/^pk_[A-Za-z\d_-]+$/.test(options.apiKey) || !PUBLIK_MODELS.includes(options.model)) {
      throw upstreamError('publik_not_configured', 'Publik chat is not configured for this account.');
    }
  }

  async complete(input: ModelCompletionInput): Promise<ModelCompletion> {
    const body = makeBody(this.options.model, input);
    const started = performance.now();
    const signal = AbortSignal.timeout(this.options.requestTimeoutMs ?? 90_000);
    try {
      const response = await (this.options.fetch ?? fetch)(`${PUBLIK_ORIGIN}/api/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        signal,
        redirect: 'error',
        body,
      });
      if (response.status === 402) {
        const payload = object(await response.json().catch(() => null));
        const error = object(payload.error);
        throw new PublikPaymentRequiredError(error.message, error.top_up_url);
      }
      if (response.status === 413) throw tooLarge();
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw upstreamError(`publik_http_${response.status}`);
      }
      if (response.headers.get('content-type')?.includes('application/json')) {
        const result = completion(object(await response.json()), '', this.options.model, started);
        if (result.content) await input.onTextDelta?.(result.content);
        return result;
      }
      return await consumeResponsesStream(response, input, this.options.model, started);
    } catch (error) {
      if (error instanceof ModelProviderError || error instanceof PublikInputError) throw error;
      if (signal.aborted) throw upstreamError('publik_timeout', 'Publik took too long to respond.');
      throw upstreamError('publik_unreachable', 'Publik is not reachable. Check your connection.');
    }
  }
}
