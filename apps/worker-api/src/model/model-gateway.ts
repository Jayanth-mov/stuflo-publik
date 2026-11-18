export type ModelRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelMessage {
  role: ModelRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
  inputFiles?: ModelInputFile[];
  // Opaque provider output, replayed only during the current internal tool loop.
  reasoningItems?: ModelReasoningItem[];
}

export interface ModelReasoningItem {
  type: 'reasoning';
  encrypted_content: string;
  [key: string]: unknown;
}

export interface ModelInputFile {
  name: string;
  mimeType: string;
  base64Data: string;
  detail?: 'auto' | 'low' | 'high';
}

export interface ModelTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelCompletion {
  content: string;
  toolCalls: ModelToolCall[];
  provider: string | null;
  model: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens?: number | null;
    cacheWriteInputTokens?: number | null;
  };
  // A recovery completion can contain several provider requests. Keep their
  // usage separate for pricing thresholds, while usage retains token totals.
  usageAttempts?: Array<ModelCompletion['usage'] | null>;
  durationMs: number;
  reasoningItems?: ModelReasoningItem[];
  serviceTier?: string;
}

export interface ModelCompletionInput {
  messages: ModelMessage[];
  tools?: ModelTool[];
  metadata?: Record<string, string>;
  onTextDelta?: (delta: string) => void | Promise<void>;
}

export interface ModelGateway {
  complete(input: ModelCompletionInput): Promise<ModelCompletion>;
}

const WORKERS_AI_MODEL = '@cf/moonshotai/kimi-k2.6' as const;

export interface WorkersAiModelGatewayOptions {
  ai: Ai;
  gatewayId: string;
}

export class WorkersAiModelGateway implements ModelGateway {
  private readonly options: WorkersAiModelGatewayOptions;

  constructor(options: WorkersAiModelGatewayOptions) {
    if (!options.ai || !options.gatewayId) {
      throw new Error('Workers AI binding and AI Gateway ID are required.');
    }
    this.options = options;
  }

  async complete(input: ModelCompletionInput): Promise<ModelCompletion> {
    const startedAt = performance.now();
    const messages = input.messages.map((message) => ({
      ...message,
      content: message.inputFiles?.length
        ? `${message.content || ''}\n\n[${message.inputFiles.length} file input(s) are stored, but binary document reading is unavailable while StuFlo is using its emergency AI fallback.]`
        : message.content,
      inputFiles: undefined,
      reasoningItems: undefined,
    }));
    const request: ChatCompletionsInput = {
      messages: messages as ChatCompletionMessageParam[],
      ...(input.tools?.length
        ? { tools: input.tools as ChatCompletionTool[], tool_choice: 'auto' as const }
        : {}),
      max_tokens: 1_200,
      temperature: 0.2,
    };
    const response = await this.options.ai.run(WORKERS_AI_MODEL, request, {
      gateway: {
        id: this.options.gatewayId,
        // This emergency fallback remains unlogged because the binding cannot
        // explicitly suppress payloads while retaining metadata-only records.
        collectLog: false,
        skipCache: true,
        requestTimeoutMs: 90_000,
        retries: { maxAttempts: 2 },
      },
    });
    const message = response.choices?.[0]?.message;
    if (!message) throw new Error('Workers AI returned no assistant message.');
    const content = message.content || '';
    if (content && input.onTextDelta) await input.onTextDelta(content);
    const toolCalls: ModelToolCall[] = (message.tool_calls || []).flatMap((call) =>
      call.type === 'function' ? [call] : [],
    );

    return {
      content,
      toolCalls,
      provider: 'workers-ai',
      model: response.model || WORKERS_AI_MODEL,
      usage: {
        inputTokens:
          typeof response.usage?.prompt_tokens === 'number' ? response.usage.prompt_tokens : null,
        outputTokens:
          typeof response.usage?.completion_tokens === 'number'
            ? response.usage.completion_tokens
            : null,
      },
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }
}

interface OpenAiResponseItem {
  [key: string]: unknown;
  id?: string;
  type?: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
  encrypted_content?: string;
}

interface OpenAiResponse {
  id?: string;
  status?: string;
  model?: string;
  service_tier?: string;
  output?: OpenAiResponseItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
  error?: { message?: string; code?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

interface OpenAiStreamEvent {
  type?: string;
  delta?: string;
  item?: OpenAiResponseItem;
  response?: OpenAiResponse;
  error?: { message?: string };
  message?: string;
}

export class IncompleteModelStreamError extends Error {
  constructor(
    readonly reason: string,
    readonly partialContent: string,
    readonly usage: ModelCompletion['usage'] | null = null,
    readonly usageAttempts: Array<ModelCompletion['usage'] | null> = [],
  ) {
    super(`OpenAI response was incomplete (${reason}).`);
    this.name = 'IncompleteModelStreamError';
  }
}

export class ModelProviderError extends Error {
  constructor(readonly status: number, readonly providerCode: string | null, message: string) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

function combinedUsage(usages: Array<ModelCompletion['usage'] | null>) {
  const sum = (
    key: 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens',
  ) => {
    const values = usages.flatMap((usage) =>
      typeof usage?.[key] === 'number' ? [usage[key]] : [],
    );
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cachedInputTokens: sum('cachedInputTokens'),
    cacheWriteInputTokens: sum('cacheWriteInputTokens'),
  };
}

export interface OpenAiModelGatewayOptions {
  accountId?: string;
  gatewayToken?: string;
  openAiApiKey: string;
  gatewayId?: string;
  model: string;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  // Server-selected static developer prefix. Optional until live passthrough
  // and cache reuse have been verified; never supplied by a student prompt.
  cachePrefix?: string;
  fetch?: typeof fetch;
}

function responseInput(messages: ModelMessage[], cachePrefix?: string) {
  const items: Array<Record<string, unknown>> = [];
  let prefixApplied = false;
  for (const message of messages) {
    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content || '',
      });
      continue;
    }
    // Preserve the original structured reasoning items; never convert opaque
    // content into developer text or follow instructions from a summary.
    if (message.role === 'assistant') {
      items.push(...(message.reasoningItems || []).filter((item) => item.type === 'reasoning' && typeof item.encrypted_content === 'string'));
    }
    if (message.content || message.inputFiles?.length) {
      const markedPrefix = cachePrefix && !prefixApplied && message.role === 'system';
      if (markedPrefix && (!message.content?.startsWith(cachePrefix) || message.inputFiles?.length)) {
        throw new Error('Prompt cache prefix must match the first developer message.');
      }
      const content = markedPrefix
        ? [
            { type: 'input_text', text: cachePrefix, prompt_cache_breakpoint: { mode: 'explicit' } },
            ...(message.content!.length > cachePrefix.length ? [{ type: 'input_text', text: message.content!.slice(cachePrefix.length) }] : []),
          ]
        : message.inputFiles?.length
        ? [
            ...(message.content ? [{ type: 'input_text', text: message.content }] : []),
            ...message.inputFiles.map((file) =>
              file.mimeType.startsWith('image/')
                ? {
                    type: 'input_image',
                    image_url: `data:${file.mimeType};base64,${file.base64Data}`,
                    detail: file.detail || 'auto',
                  }
                : {
                    type: 'input_file',
                    filename: file.name,
                    file_data: `data:${file.mimeType};base64,${file.base64Data}`,
                    ...(file.mimeType === 'application/pdf' ? { detail: file.detail || 'low' } : {}),
                  },
            ),
          ]
        : message.content;
      items.push({
        role: message.role === 'system' ? 'developer' : message.role,
        content,
      });
      if (markedPrefix) prefixApplied = true;
    }
    for (const call of message.tool_calls || []) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  if (cachePrefix && !prefixApplied) throw new Error('Prompt cache prefix requires a developer message.');
  return items;
}

function responseTools(tools: ModelTool[] | undefined) {
  return (tools || []).map((tool) => ({
    type: 'function' as const,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    // StuFlo's schemas intentionally contain optional filters, so strict mode
    // cannot require every declared property.
    strict: false,
  }));
}

function completionFromResponse(
  response: OpenAiResponse,
  streamedContent: string,
  durationMs: number,
  fallbackModel: string,
): ModelCompletion {
  const output = Array.isArray(response.output) ? response.output : [];
  const finalContent = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
    .map((content) => content.text || '')
    .join('');
  const toolCalls: ModelToolCall[] = output.flatMap((item) =>
    item.type === 'function_call' && item.name
      ? [
          {
            id: item.call_id || item.id || crypto.randomUUID(),
            type: 'function' as const,
            function: { name: item.name, arguments: item.arguments || '{}' },
          },
        ]
      : [],
  );
  return {
    content: finalContent || streamedContent,
    toolCalls,
    provider: 'openai',
    model: response.model || fallbackModel,
    usage: {
      inputTokens:
        typeof response.usage?.input_tokens === 'number' ? response.usage.input_tokens : null,
      outputTokens:
        typeof response.usage?.output_tokens === 'number' ? response.usage.output_tokens : null,
      cachedInputTokens:
        typeof response.usage?.input_tokens_details?.cached_tokens === 'number'
          ? response.usage.input_tokens_details.cached_tokens
          : null,
      cacheWriteInputTokens:
        typeof response.usage?.input_tokens_details?.cache_write_tokens === 'number'
          ? response.usage.input_tokens_details.cache_write_tokens
          : null,
    },
    durationMs,
    reasoningItems: output.filter((item) => item.type === 'reasoning' && typeof item.encrypted_content === 'string') as ModelReasoningItem[],
    ...(response.service_tier ? { serviceTier: response.service_tier } : {}),
  };
}

export class OpenAiModelGateway implements ModelGateway {
  private readonly options: OpenAiModelGatewayOptions;

  constructor(options: OpenAiModelGatewayOptions) {
    if (!options.openAiApiKey || !options.model) {
      throw new Error('OpenAI API key and model are required.');
    }
    if (options.gatewayToken && (!options.accountId || !options.gatewayId)) {
      throw new Error('Cloudflare account and Gateway ID are required with a Gateway token.');
    }
    if (options.maxOutputTokens !== undefined &&
        (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 256 || options.maxOutputTokens > 16_000)) {
      throw new Error('Model output limit must be an integer between 256 and 16000 tokens.');
    }
    if (options.requestTimeoutMs !== undefined &&
        (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)) {
      throw new Error('Model request timeout must be positive.');
    }
    if (options.cachePrefix !== undefined &&
        (typeof options.cachePrefix !== 'string' || !options.cachePrefix.trim() || options.cachePrefix.length > 64_000)) {
      throw new Error('Prompt cache prefix must contain at most 64000 characters.');
    }
    this.options = options;
  }

  async complete(input: ModelCompletionInput): Promise<ModelCompletion> {
    const startedAt = performance.now();
    let accumulatedContent = '';
    let recoveryInput = input;
    const recoveredUsage: Array<ModelCompletion['usage'] | null> = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let attemptContent = '';
      const relayDelta = async (delta: string) => {
        attemptContent += delta;
        accumulatedContent += delta;
        if (input.onTextDelta) await input.onTextDelta(delta);
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 90_000);
      try {
        const completion = await this.completeOnce({ ...recoveryInput, onTextDelta: relayDelta }, controller.signal);
        if (completion.content.startsWith(attemptContent)) {
          const unstreamedSuffix = completion.content.slice(attemptContent.length);
          if (unstreamedSuffix) await relayDelta(unstreamedSuffix);
        } else if (!attemptContent && completion.content) {
          await relayDelta(completion.content);
        }
        return {
          ...completion,
          content: accumulatedContent || completion.content,
          usage: combinedUsage([...recoveredUsage, completion.usage]),
          usageAttempts: [...recoveredUsage, completion.usage],
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        };
      } catch (error) {
        if (!(error instanceof IncompleteModelStreamError)) throw error;
        recoveredUsage.push(error.usage);

        if (error.partialContent.startsWith(attemptContent)) {
          const unstreamedSuffix = error.partialContent.slice(attemptContent.length);
          if (unstreamedSuffix) await relayDelta(unstreamedSuffix);
        } else if (!attemptContent && error.partialContent) {
          await relayDelta(error.partialContent);
        }

        const recoverable = ['max_tokens', 'max_output_tokens', 'stream_ended'].includes(error.reason);
        if (!recoverable || attempt === 1) {
          throw new IncompleteModelStreamError(
            error.reason,
            accumulatedContent,
            combinedUsage(recoveredUsage),
            recoveredUsage,
          );
        }

        recoveryInput = accumulatedContent
          ? {
              ...input,
              messages: [
                ...input.messages,
                { role: 'assistant', content: accumulatedContent },
                {
                  role: 'user',
                  content:
                    'Continue the interrupted answer from exactly where the assistant text ended. Do not repeat earlier text. Finish the requested answer, using tools if they are still needed.',
                },
              ],
            }
          : input;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new IncompleteModelStreamError('stream_ended', accumulatedContent);
  }

  private async completeOnce(input: ModelCompletionInput, signal: AbortSignal): Promise<ModelCompletion> {
    const startedAt = performance.now();
    const fetcher = this.options.fetch ?? fetch;
    const metadata = Object.fromEntries(
      Object.entries(input.metadata || {})
        .filter(([, value]) => typeof value === 'string' && value.length > 0)
        .slice(0, 5)
        .map(([key, value]) => [key.slice(0, 64), value.slice(0, 256)]),
    );
    const tools = responseTools(input.tools);
    const usingGateway = Boolean(this.options.gatewayToken);
    const endpoint = usingGateway
      ? `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(this.options.accountId!)}/${encodeURIComponent(this.options.gatewayId!)}/openai/responses`
      : 'https://api.openai.com/v1/responses';
    const response = await fetcher(
      endpoint,
      {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${this.options.openAiApiKey}`,
          ...(usingGateway
            ? {
                'cf-aig-authorization': `Bearer ${this.options.gatewayToken}`,
                'cf-aig-collect-log': 'true',
                'cf-aig-collect-log-payload': 'false',
                ...(Object.keys(metadata).length
                  ? { 'cf-aig-metadata': JSON.stringify(metadata) }
                  : {}),
              }
            : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          // Match credit estimates to Standard pricing, regardless of the
          // provider project's mutable default processing tier.
          service_tier: 'default',
          input: responseInput(input.messages, this.options.cachePrefix),
          ...(this.options.cachePrefix ? { prompt_cache_options: { mode: 'implicit' } } : {}),
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
          reasoning: { effort: this.options.reasoningEffort ?? 'low' },
          text: { verbosity: 'low' },
          max_output_tokens: this.options.maxOutputTokens ?? 3_000,
          safety_identifier: input.metadata?.student,
          store: false,
          stream: true,
        }),
      },
    );

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as OpenAiResponse;
      throw new ModelProviderError(response.status, payload.error?.code || null, payload.error?.message || `AI Gateway returned HTTP ${response.status}.`);
    }
    if (!response.body) throw new Error('OpenAI returned no response stream.');

    if ((response.headers.get('content-type') || '').includes('application/json')) {
      const payload = (await response.json()) as OpenAiResponse;
      const completion = completionFromResponse(
        payload,
        '',
        Math.max(0, Math.round(performance.now() - startedAt)),
        this.options.model,
      );
      if (payload.status === 'incomplete') {
        throw new IncompleteModelStreamError(
          payload.incomplete_details?.reason || 'unknown',
          completion.content,
          completion.usage,
        );
      }
      if (payload.status === 'failed') {
        throw new Error(payload.error?.message || 'OpenAI request failed.');
      }
      if (completion.content && input.onTextDelta) await input.onTextDelta(completion.content);
      return completion;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedContent = '';
    let completed: OpenAiResponse | null = null;
    let incomplete: OpenAiResponse | null = null;

    const consumeBlock = async (block: string) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') return;
      let event: OpenAiStreamEvent;
      try {
        event = JSON.parse(data) as OpenAiStreamEvent;
      } catch {
        return;
      }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        streamedContent += event.delta;
        if (input.onTextDelta) await input.onTextDelta(event.delta);
      }
      if (event.type === 'response.completed' && event.response) completed = event.response;
      if (event.type === 'response.incomplete' && event.response) incomplete = event.response;
      if (event.type === 'response.failed' || event.type === 'error') {
        throw new Error(
          event.response?.error?.message || event.error?.message || event.message || 'OpenAI request failed.',
        );
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      // Normalize after joining chunks: a CRLF delimiter may straddle reads.
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        await consumeBlock(block);
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    if (buffer.trim()) await consumeBlock(buffer);
    const incompleteResponse = incomplete as OpenAiResponse | null;
    if (!completed) {
      const partialCompletion = incompleteResponse
        ? completionFromResponse(
            incompleteResponse,
            streamedContent,
            Math.max(0, Math.round(performance.now() - startedAt)),
            this.options.model,
          )
        : null;
      throw new IncompleteModelStreamError(
        incompleteResponse?.incomplete_details?.reason || 'stream_ended',
        partialCompletion?.content || streamedContent,
        partialCompletion?.usage || null,
      );
    }
    return completionFromResponse(
      completed,
      streamedContent,
      Math.max(0, Math.round(performance.now() - startedAt)),
      this.options.model,
    );
  }
}
