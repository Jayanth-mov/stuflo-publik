import { describe, expect, it, vi } from 'vitest';
import { OpenAiModelGateway, WorkersAiModelGateway } from '../src/model/model-gateway';

describe('WorkersAiModelGateway', () => {
  it('runs Kimi through the Workers AI fallback and normalizes tool calls', async () => {
    const run = vi.fn().mockResolvedValue({
      model: '@cf/moonshotai/kimi-k2.6',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'tool-1',
                type: 'function',
                function: { name: 'canvas_get_assignments', arguments: '{}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });
    const gateway = new WorkersAiModelGateway({
      ai: { run } as unknown as Ai,
      gatewayId: 'stuflo',
    });

    await expect(
      gateway.complete({
        messages: [{ role: 'user', content: "What's due?" }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'canvas_get_assignments',
              description: 'List assignments',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      }),
    ).resolves.toMatchObject({
      content: '',
      provider: 'workers-ai',
      model: '@cf/moonshotai/kimi-k2.6',
      toolCalls: [{ id: 'tool-1', function: { name: 'canvas_get_assignments' } }],
      usage: { inputTokens: 20, outputTokens: 5 },
    });
    expect(run).toHaveBeenCalledWith(
      '@cf/moonshotai/kimi-k2.6',
      expect.objectContaining({ tool_choice: 'auto', max_tokens: 1_200 }),
      expect.objectContaining({
        gateway: expect.objectContaining({ id: 'stuflo', collectLog: false, skipCache: true }),
      }),
    );
  });
});

function streamingResponse(events: unknown[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenAiModelGateway', () => {
  it('marks only the server-selected static developer prefix with the documented cache boundary', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: 'completed', output: [] }));
    const gateway = new OpenAiModelGateway({ openAiApiKey: 'openai-key', model: 'gpt-6-sol', cachePrefix: 'Stable instructions.', fetch: fetcher });
    await gateway.complete({ messages: [{ role: 'system', content: 'Stable instructions. Dynamic student context.' }, { role: 'user', content: 'Question.' }] });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      prompt_cache_options: { mode: 'implicit' },
      input: [
        { role: 'developer', content: [
          { type: 'input_text', text: 'Stable instructions.', prompt_cache_breakpoint: { mode: 'explicit' } },
          { type: 'input_text', text: ' Dynamic student context.' },
        ] },
        { role: 'user', content: 'Question.' },
      ],
    });
  });

  it('rejects a cache prefix that could replace or rearrange developer instructions', async () => {
    const fetcher = vi.fn();
    const gateway = new OpenAiModelGateway({ openAiApiKey: 'openai-key', model: 'gpt-6-sol', cachePrefix: 'Other content.', fetch: fetcher });
    await expect(gateway.complete({ messages: [{ role: 'system', content: 'Real instructions.' }] })).rejects.toThrow('must match');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('replays encrypted reasoning structurally without treating it as developer instructions', async () => {
    const reasoning = { id: 'rs-test', type: 'reasoning' as const, encrypted_content: 'opaque-encrypted-content', summary: [] };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ output: [reasoning, { type: 'function_call', call_id: 'call-1', name: 'canvas_get_assignments', arguments: '{}' }] })).mockResolvedValueOnce(Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }] }));
    const gateway = new OpenAiModelGateway({ openAiApiKey: 'openai-key', model: 'gpt-6-luna', fetch: fetcher });
    const first = await gateway.complete({ messages: [{ role: 'user', content: 'What is due?' }] });
    expect(first.reasoningItems).toEqual([reasoning]);
    await gateway.complete({ messages: [{ role: 'user', content: 'What is due?' }, { role: 'assistant', content: null, tool_calls: first.toolCalls, reasoningItems: first.reasoningItems }, { role: 'tool', tool_call_id: 'call-1', content: '{}' }] });
    const input = JSON.parse(fetcher.mock.calls[1][1].body).input;
    expect(input[1]).toEqual(reasoning);
    expect(input[2]).toMatchObject({ type: 'function_call', call_id: 'call-1' });
    expect(input[3]).toMatchObject({ type: 'function_call_output', call_id: 'call-1' });
    expect(input.filter((item: { role?: string }) => item.role === 'developer')).toHaveLength(0);
  });

  it('uses configurable reasoning and output budgets with a bounded request signal', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: 'completed', output: [] }));
    const gateway = new OpenAiModelGateway({ openAiApiKey: 'openai-key', model: 'gpt-6-luna', reasoningEffort: 'none', maxOutputTokens: 1_000, fetch: fetcher });
    await gateway.complete({ messages: [] });
    const init = fetcher.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toMatchObject({ reasoning: { effort: 'none' }, max_output_tokens: 1_000, service_tier: 'default' });
  });

  it('parses CRLF event delimiters that split across arbitrary stream chunks', async () => {
    const text = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' })}\r\n\r\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }], usage: { input_tokens: 4, output_tokens: 1 } } })}\r\n\r\n`;
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    const gateway = new OpenAiModelGateway({ openAiApiKey: 'openai-key', model: 'gpt-6-luna', fetch: vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })) });
    await expect(gateway.complete({ messages: [] })).resolves.toMatchObject({ content: 'Hello', usage: { inputTokens: 4, outputTokens: 1 } });
  });

  it('aborts stalled model requests instead of leaving a chat pending indefinitely', async () => {
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
    }));
    const gateway = new OpenAiModelGateway({ openAiApiKey: 'openai-key', model: 'gpt-6-luna', requestTimeoutMs: 5, fetch: fetcher });
    await expect(gateway.complete({ messages: [] })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('streams Responses API text through AI Gateway while excluding payload logs', async () => {
    const completedResponse = {
      model: 'gpt-5.6-terra',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Hello from Stu' }],
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      },
    };
    const fetcher = vi.fn().mockResolvedValue(
      streamingResponse([
        { type: 'response.output_text.delta', delta: 'Hello ' },
        { type: 'response.output_text.delta', delta: 'from Stu' },
        { type: 'response.completed', response: completedResponse },
      ]),
    );
    const onTextDelta = vi.fn();
    const gateway = new OpenAiModelGateway({
      accountId: 'account-id',
      gatewayToken: 'gateway-token',
      openAiApiKey: 'openai-key',
      gatewayId: 'stuflo',
      model: 'gpt-5.6-terra',
      fetch: fetcher,
    });
    await expect(
      gateway.complete({
        messages: [
          { role: 'system', content: 'You are Stu.' },
          { role: 'user', content: 'Hello' },
        ],
        metadata: { student: 'student_example', operation: 'stu-chat' },
        onTextDelta,
      }),
    ).resolves.toMatchObject({
      content: 'Hello from Stu',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 2,
      },
    });
    expect(onTextDelta.mock.calls.map(([delta]) => delta).join('')).toBe('Hello from Stu');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-id/stuflo/openai/responses',
    );
    expect(init.headers).toMatchObject({
      authorization: 'Bearer openai-key',
      'cf-aig-authorization': 'Bearer gateway-token',
      'cf-aig-collect-log': 'true',
      'cf-aig-collect-log-payload': 'false',
      'cf-aig-metadata': JSON.stringify({
        student: 'student_example',
        operation: 'stu-chat',
      }),
    });
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'gpt-5.6-terra',
      stream: true,
      store: false,
      service_tier: 'default',
      reasoning: { effort: 'low' },
      max_output_tokens: 3_000,
      input: [
        { role: 'developer', content: 'You are Stu.' },
        { role: 'user', content: 'Hello' },
      ],
    });
  });

  it('continues an answer automatically when OpenAI reports the output-token limit', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        streamingResponse([
          { type: 'response.output_text.delta', delta: 'First half.' },
          {
            type: 'response.incomplete',
            response: {
              status: 'incomplete',
              model: 'gpt-5.6-terra',
              incomplete_details: { reason: 'max_tokens' },
              output: [
                { type: 'message', content: [{ type: 'output_text', text: 'First half.' }] },
              ],
              usage: { input_tokens: 18, output_tokens: 1_200 },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        streamingResponse([
          { type: 'response.output_text.delta', delta: ' Second half.' },
          {
            type: 'response.completed',
            response: {
              status: 'completed',
              model: 'gpt-5.6-terra',
              output: [
                { type: 'message', content: [{ type: 'output_text', text: ' Second half.' }] },
              ],
              usage: { input_tokens: 30, output_tokens: 5 },
            },
          },
        ]),
      );
    const onTextDelta = vi.fn();
    const gateway = new OpenAiModelGateway({
      openAiApiKey: 'openai-key',
      model: 'gpt-5.6-terra',
      fetch: fetcher,
    });

    await expect(
      gateway.complete({
        messages: [{ role: 'user', content: 'Give me a detailed answer.' }],
        onTextDelta,
      }),
    ).resolves.toMatchObject({
      content: 'First half. Second half.',
      usage: { inputTokens: 48, outputTokens: 1_205 },
      usageAttempts: [
        expect.objectContaining({ inputTokens: 18, outputTokens: 1_200 }),
        expect.objectContaining({ inputTokens: 30, outputTokens: 5 }),
      ],
    });
    expect(onTextDelta.mock.calls.map(([delta]) => delta).join('')).toBe(
      'First half. Second half.',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    const recoveryBody = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(recoveryBody.input.slice(-2)).toEqual([
      { role: 'assistant', content: 'First half.' },
      {
        role: 'user',
        content: expect.stringContaining('Continue the interrupted answer'),
      },
    ]);
  });

  it('preserves the full partial response when automatic recovery also stops early', async () => {
    const incomplete = (delta: string) =>
      streamingResponse([
        { type: 'response.output_text.delta', delta },
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_tokens' },
            output: [{ type: 'message', content: [{ type: 'output_text', text: delta }] }],
          },
        },
      ]);
    const gateway = new OpenAiModelGateway({
      openAiApiKey: 'openai-key',
      model: 'gpt-5.6-terra',
      fetch: vi.fn().mockResolvedValueOnce(incomplete('Part one.')).mockResolvedValueOnce(incomplete(' Part two.')),
    });

    await expect(gateway.complete({ messages: [] })).rejects.toMatchObject({
      name: 'IncompleteModelStreamError',
      reason: 'max_tokens',
      partialContent: 'Part one. Part two.',
      usageAttempts: [
        expect.objectContaining({ inputTokens: null, outputTokens: null }),
        expect.objectContaining({ inputTokens: null, outputTokens: null }),
      ],
    });
  });

  it('normalizes Responses API function calls for the Stu tool loop', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      streamingResponse([
        {
          type: 'response.completed',
          response: {
            model: 'gpt-5.6-terra',
            output: [
              {
                id: 'item-1',
                type: 'function_call',
                call_id: 'call-1',
                name: 'canvas_get_assignments',
                arguments: '{"includeUndated":false}',
              },
            ],
            usage: { input_tokens: 20, output_tokens: 8 },
          },
        },
      ]),
    );
    const gateway = new OpenAiModelGateway({
      openAiApiKey: 'openai-key',
      model: 'gpt-5.6-terra',
      fetch: fetcher,
    });
    await expect(gateway.complete({ messages: [] })).resolves.toMatchObject({
      toolCalls: [
        {
          id: 'call-1',
          function: {
            name: 'canvas_get_assignments',
            arguments: '{"includeUndated":false}',
          },
        },
      ],
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers).toMatchObject({ authorization: 'Bearer openai-key' });
    expect(init.headers).not.toHaveProperty('cf-aig-authorization');
    expect(init.headers).not.toHaveProperty('cf-aig-collect-log');
  });

  it('sends stored PDFs and images as Responses API multimodal inputs', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      streamingResponse([
        {
          type: 'response.completed',
          response: {
            model: 'gpt-5.6-terra',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Read it.' }] }],
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        },
      ]),
    );
    const gateway = new OpenAiModelGateway({
      openAiApiKey: 'openai-key',
      model: 'gpt-5.6-terra',
      fetch: fetcher,
    });
    await gateway.complete({
      messages: [{
        role: 'user',
        content: 'Inspect these files.',
        inputFiles: [
          { name: 'Syllabus.pdf', mimeType: 'application/pdf', base64Data: 'cGRm', detail: 'low' },
          { name: 'diagram.png', mimeType: 'image/png', base64Data: 'cG5n', detail: 'auto' },
        ],
      }],
    });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: 'Inspect these files.' },
      {
        type: 'input_file',
        filename: 'Syllabus.pdf',
        file_data: 'data:application/pdf;base64,cGRm',
        detail: 'low',
      },
      {
        type: 'input_image',
        image_url: 'data:image/png;base64,cG5n',
        detail: 'auto',
      },
    ]);
  });

  it('surfaces safe upstream errors', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ error: { message: 'Model unavailable' } }, { status: 503 }));
    const gateway = new OpenAiModelGateway({
      openAiApiKey: 'openai-key',
      model: 'gpt-5.6-terra',
      fetch: fetcher,
    });
    await expect(gateway.complete({ messages: [] })).rejects.toThrow('Model unavailable');
  });
});
