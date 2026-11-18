import { describe, expect, it, vi } from 'vitest';
import type { ModelCompletionInput } from '../src/model/model-gateway';
import {
  PublikModelGateway,
  PublikPaymentRequiredError,
} from '../src/model/publik-model-gateway';

const apiKey = 'pk_' + 'synthetic-test-credential';
const endpoint = 'https://publikhq.com/api/v1/responses';

function gateway(fetcher: typeof fetch) {
  return new PublikModelGateway({ apiKey, model: 'publik-balanced', fetch: fetcher });
}

const input: ModelCompletionInput = { messages: [{ role: 'user', content: 'When is my next assignment due?' }] };

function event(data: Record<string, unknown>) {
  return `data: ${JSON.stringify(data)}\r\n\r\n`;
}

function streamResponse(packets: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const packet of packets) controller.enqueue(encoder.encode(packet));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

describe('PublikModelGateway', () => {
  it('streams terminal text, maps tool calls and usage, and sends no student metadata', async () => {
    const text = vi.fn();
    const first = event({ type: 'response.output_text.delta', delta: 'Let’s check.' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      first.slice(0, -1),
      first.slice(-1),
      event({ type: 'response.completed', response: {
        status: 'completed',
        model: 'vendor/test-model',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Let’s check.' }] },
          { type: 'function_call', call_id: 'call_2', name: 'list_assignments', arguments: '{"days":3}' },
        ],
        usage: { input_tokens: 17, output_tokens: 7, input_tokens_details: { cached_tokens: 3 } },
      } }),
    ]));
    const result = await gateway(fetcher).complete({
      messages: [
        { role: 'system', content: 'Use tools when needed.' },
        ...input.messages,
        { role: 'assistant', content: null, tool_calls: [{
          id: 'call_1', type: 'function', function: { name: 'list_courses', arguments: '{}' },
        }] },
        { role: 'tool', content: '{"courses":[]}', tool_call_id: 'call_1' },
      ],
      tools: [{ type: 'function', function: { name: 'list_assignments', description: 'List assignments.', parameters: { type: 'object' } } }],
      onTextDelta: text,
      metadata: { student: 'private-student-id', plan: 'unknown' },
    });
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(request).toMatchObject({ redirect: 'error', method: 'POST', headers: { authorization: `Bearer ${apiKey}` } });
    expect(request?.body).not.toContain('private-student-id');
    expect(JSON.parse(String(request?.body))).toEqual({
      model: 'publik-balanced',
      input: [
        { role: 'developer', content: 'Use tools when needed.' },
        ...input.messages,
        { type: 'function_call', call_id: 'call_1', name: 'list_courses', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"courses":[]}' },
      ],
      tools: [{ type: 'function', name: 'list_assignments', description: 'List assignments.', parameters: { type: 'object' }, strict: false }],
      tool_choice: 'auto',
      max_output_tokens: 3_000,
      store: false,
      stream: true,
    });
    expect(text.mock.calls).toEqual([['Let’s check.']]);
    expect(result).toMatchObject({
      content: 'Let’s check.', provider: 'publik', model: 'vendor/test-model',
      toolCalls: [{ id: 'call_2', type: 'function', function: { name: 'list_assignments', arguments: '{"days":3}' } }],
      usage: { inputTokens: 17, outputTokens: 7, cachedInputTokens: 3, cacheWriteInputTokens: null },
    });
  });

  it('accepts a small encoded image and handles a JSON completion', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'I see the image.' }] }],
    }));
    const text = vi.fn();
    const result = await gateway(fetcher).complete({
      messages: [{ role: 'user', content: 'What does this show?', inputFiles: [{ name: 'chart.png', mimeType: 'image/png', base64Data: 'dGVzdA==' }] }],
      onTextDelta: text,
    });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).input[0]).toEqual({
      role: 'user', content: [
        { type: 'input_text', text: 'What does this show?' },
        { type: 'input_image', image_url: 'data:image/png;base64,dGVzdA==', detail: 'auto' },
      ],
    });
    expect(text.mock.calls).toEqual([['I see the image.']]);
    expect(result).toMatchObject({ model: 'publik-balanced', content: 'I see the image.' });
  });

  it.each([
    ['/wallet', 'https://publikhq.com/wallet'],
    ['https://publikhq.com.evil.example/wallet', null],
    ['https://user:password@publikhq.com/wallet', null],
    ['javascript:alert(1)', null],
  ])('returns a typed 402 with a safe link for %s', async (topUpUrl, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: {
      message: `Add credit for ${apiKey}.`, top_up_url: topUpUrl,
    } }, { status: 402 }));
    const request = gateway(fetcher).complete(input);
    await expect(request).rejects.toBeInstanceOf(PublikPaymentRequiredError);
    await expect(request).rejects.toMatchObject({ status: 402, message: 'Add credit for [redacted].', topUpUrl: expected });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported documents and oversized UTF-8 input before making a chargeable call', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(gateway(fetcher).complete({
      messages: [{ role: 'user', content: 'Read this.', inputFiles: [{ name: 'course.pdf', mimeType: 'application/pdf', base64Data: 'dGVzdA==' }] }],
    })).rejects.toMatchObject({ status: 400, code: 'publik_unsupported_file' });
    await expect(gateway(fetcher).complete({
      messages: [{ role: 'user', content: '訓'.repeat(1_334_000) }],
    })).rejects.toMatchObject({ status: 413, code: 'publik_input_too_large' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not replay an incomplete stream or expose upstream error text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      event({ type: 'response.output_text.delta', delta: 'Partial reply.' }),
      event({ type: 'response.incomplete', response: { error: { message: apiKey } } }),
    ]));
    const request = gateway(fetcher).complete(input);
    await expect(request).rejects.toMatchObject({ providerCode: 'publik_response_incomplete' });
    await expect(request).rejects.not.toThrow(apiKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
