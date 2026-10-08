import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesProvider, AuthenticatedResponsesProvider, GenericChatProvider, buildAnthropicBody } from '../core/providers/protocols.ts';
import { createResponse, type Request, type StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { record, message, functionResult, responseRecords } from 'cortico/protocol/open-responses/context.ts';
import { GenerationError } from 'cortico/core/generation.ts';

const request: Request = { model: 'test-model', input: 'Hello' };
const origin = { instance: 'test', module: 'anthropic', model: 'test-model', compatibilityDomain: 'https://example.test/v1' };
const baseUrl = 'https://example.test/v1';
const json = (value: unknown, status = 200): globalThis.Response => new globalThis.Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function sse(events: unknown[]): globalThis.Response {
  const bytes = new TextEncoder().encode(events.map(value => `event: ignored\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join(''));
  let position = 0;
  return new globalThis.Response(new ReadableStream({ pull(controller) {
    if (position >= bytes.length) { controller.close(); return; }
    const next = Math.min(position + 17, bytes.length); controller.enqueue(bytes.slice(position, next)); position = next;
  } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-test' } });
}
function anthropic(blocks: Array<Record<string, unknown>>, reason = 'end_turn'): unknown[] {
  return [{ type: 'message_start', message: { id: 'msg-test', type: 'message', role: 'assistant', model: 'test-model', content: [], usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } } },
    ...blocks.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 8 } }, { type: 'message_stop' }];
}
function chat(delta: unknown, reason: string | null = null): unknown { return { id: 'chat-test', model: 'test-model', choices: [{ index: 0, delta, finish_reason: reason }] }; }
function responseEvents(): unknown[] {
  const initial = createResponse('resp-test', request);
  const terminal = { ...initial, status: 'completed' };
  return [{ type: 'response.created', sequence_number: 0, response: initial }, { type: 'response.completed', sequence_number: 1, response: terminal }];
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('generic authenticated protocols', () => {
  it('builds standard Chat tool/image/reasoning input without llama template flags', async () => {
    const fetch = vi.fn(async (_url?: unknown, _init?: RequestInit) => json({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] })); vi.stubGlobal('fetch', fetch);
    const provider = new GenericChatProvider({ baseUrl, apiKey: 'test-key', media: { enabled: () => true, read: () => Buffer.from('png') } });
    await provider.respond({ ...request, reasoning: { effort: 'high' }, max_output_tokens: 512, tools: [{ type: 'function', name: 'look', parameters: { type: 'object' } }] },
      { diagnostic: true, context: [message('user', 'Look', { blobs: [{ handle: 'blob:test', mime: 'image/png', fallbackText: '[image]' }] })] });
    const init = fetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ max_tokens: 512, reasoning_effort: 'high', tools: [{ type: 'function', function: { name: 'look' } }] });
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,cG5n');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
  });
  it('assembles parallel Chat tool fragments and records attempts/usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => sse([
      chat({ tool_calls: [{ index: 0, id: 'call-a', function: { name: 'look', arguments: '{"x":' } }, { index: 1, id: 'call-b', function: { name: 'look', arguments: '{"y":' } }] }),
      chat({ tool_calls: [{ index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '1}' } }] }, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } },
    ])));
    const events: StreamEvent[] = [];
    const result = await new GenericChatProvider({ baseUrl }).respond(request, { diagnostic: true, onEvent: event => events.push(event) });
    expect(result.response.output).toMatchObject([{ call_id: 'call-a', arguments: '{"x":1}', status: 'completed' }, { call_id: 'call-b', arguments: '{"y":2}', status: 'completed' }]);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ requestId: 'req-test', outcome: 'completed', meters: { input: 8, output: 6 } });
    expect(events.at(-1)?.type).toBe('response.completed');
  });
  it('marks every Chat tool incomplete on truncation, including earlier valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => sse([chat({ tool_calls: [{ index: 0, id: 'a', function: { name: 'look', arguments: '{}' } }, { index: 1, id: 'b', function: { name: 'look', arguments: '{"x":' } }] }, 'length')])));
    const events: StreamEvent[] = [];
    const result = await new GenericChatProvider({ baseUrl }).respond(request, { diagnostic: true, onEvent: event => events.push(event) });
    expect(result.response.status).toBe('incomplete');
    expect(result.response.output.every(item => item.type !== 'function_call' || item.status === 'incomplete')).toBe(true);
    expect(events.filter(event => event.type === 'response.output_item.done').every(event => event.type !== 'response.output_item.done' || event.item?.type !== 'function_call' || event.item.status === 'incomplete')).toBe(true);
  });
  it('does not emit completed tools when a supposedly completed Chat call contains invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => sse([chat({ tool_calls: [{ index: 0, id: 'a', function: { name: 'look', arguments: '{' } }] }, 'tool_calls')])));
    const events: StreamEvent[] = [];
    const error = await new GenericChatProvider({ baseUrl }).respond(request, { diagnostic: true, onEvent: event => events.push(event) }).catch(error => error);
    expect(error).toBeInstanceOf(GenerationError);
    expect(error.partial.output[0].status).toBe('incomplete');
    expect(events.some(event => event.type === 'response.output_item.done')).toBe(false);
  });
  it('refreshes once, re-reads async auth headers and preserves conversation header', async () => {
    let token = 'old';
    const auth = { headers: vi.fn(async (_url?: unknown, _init?: RequestInit) => ({ Authorization: `Bearer ${token}` })), refresh: vi.fn(async (_url?: unknown, _init?: RequestInit) => { token = 'new'; return true; }) };
    const fetch = vi.fn().mockResolvedValueOnce(json({ error: 'expired' }, 401)).mockResolvedValueOnce(json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetch);
    const result = await new GenericChatProvider({ baseUrl, auth, sessionHeader: 'x-opencode-session', extraHeaders: { 'User-Agent': 'Coopanion/test' } }).respond(request, { sessionId: 'conversation-a' });
    expect(result.attempts).toHaveLength(2);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[1][1].headers).get('authorization')).toBe('Bearer new');
    expect(new Headers(fetch.mock.calls[1][1].headers).get('x-opencode-session')).toBe('conversation-a');
  });
  it('rejects structural extra body overrides before sending', () => {
    expect(() => new GenericChatProvider({ baseUrl, extraBody: { tools: [], stream: false } })).toThrow('Unsupported provider body override');
  });
});

describe('OAuth Responses', () => {
  it('forces the streaming parser without an event observer and shapes the SIWC request', async () => {
    const fetch = vi.fn(async (_url?: unknown, _init?: RequestInit) => sse(responseEvents())); vi.stubGlobal('fetch', fetch);
    const provider = new AuthenticatedResponsesProvider({ baseUrl: 'https://api.openai.com/v1', chatgpt: true, auth: { headers: async () => ({ Authorization: 'Bearer test' }), refresh: async () => false } });
    const result = await provider.respond({ ...request, temperature: 0.3, max_output_tokens: 100, metadata: { private: 'value' }, previous_response_id: 'old',
      tools: [{ type: 'function', name: 'look', parameters: { type: 'object' } }] }, { diagnostic: true, context: [message('system', 'Be helpful'), message('user', 'Hi')] });
    const body = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body));
    expect(body).toMatchObject({ store: false, stream: true, instructions: 'Be helpful', tools: [{ type: 'namespace', name: 'coopanion', tools: [{ name: 'look' }] }] });
    for (const key of ['temperature', 'max_output_tokens', 'metadata', 'previous_response_id']) expect(body[key]).toBeUndefined();
    expect(body.include).toContain('reasoning.encrypted_content');
    expect(result.response.status).toBe('completed');
  });
  it.each([401, 403, 429])('does not refresh or retry SIWC HTTP %s; redacts upstream diagnostics', async status => {
    const auth = { headers: vi.fn(async () => ({ Authorization: 'Bearer private-test-token' })), refresh: vi.fn(async () => true) };
    const fetch = vi.fn(async (_url?: unknown, _init?: RequestInit) => new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private-test-token', param: 'model' } }),
      { status, headers: { 'openai-request-id': 'req_safe' } }));
    vi.stubGlobal('fetch', fetch);
    const error = await new AuthenticatedResponsesProvider({ baseUrl: 'https://api.openai.com/v1', chatgpt: true, auth }).respond(request).catch(error => error);
    expect(error).toBeInstanceOf(GenerationError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.redirect).toBe('error');
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(error.attempts[0]).toMatchObject({ status, requestId: 'req_safe', outcome: 'failed' });
    expect(error.message + error.body + JSON.stringify(error.partial)).not.toContain('private-test-token');
    expect(JSON.parse(error.body)).toMatchObject({ error: { code: 'subscription_sharing_usage_limit_exceeded', param: 'model' } });
  });
  it('redacts streamed quota errors before observers and records exactly one failed attempt', async () => {
    const initial = createResponse('r', request);
    const events = [
      { type: 'response.created', sequence_number: 0, response: initial },
      { type: 'response.failed', sequence_number: 1, response: { ...initial, status: 'failed', error: { code: 'subscription_sharing_usage_unavailable', message: 'private-test-token' } } },
    ];
    const fetch = vi.fn(async () => sse(events)); vi.stubGlobal('fetch', fetch);
    const observed: StreamEvent[] = [];
    const error = await new AuthenticatedResponsesProvider({ baseUrl: 'https://api.openai.com/v1', chatgpt: true }).respond(request, { onEvent: event => observed.push(event) }).catch(error => error);
    expect(fetch).toHaveBeenCalledOnce();
    expect(error.attempts).toHaveLength(1);
    expect(JSON.stringify(observed) + error.message + error.body + JSON.stringify(error.partial)).not.toContain('private-test-token');
    expect(error.partial.error.code).toBe('subscription_sharing_usage_unavailable');
  });
  it('sanitizes standalone stream errors and refuses missing response.completed', async () => {
    const initial = createResponse('r', request);
    const observed: StreamEvent[] = [];
    const provider = new AuthenticatedResponsesProvider({ baseUrl: 'https://api.openai.com/v1', chatgpt: true });
    const fetch = vi.fn(async () => sse([{ type: 'response.created', sequence_number: 0, response: initial },
      { type: 'error', sequence_number: 1, code: 'subscription_sharing_unsupported_capability', message: 'private-test-token', arbitrary: 'private-test-token' }]));
    vi.stubGlobal('fetch', fetch);
    const error = await provider.respond(request, { onEvent: event => observed.push(event) }).catch(error => error);
    expect(JSON.stringify(observed) + error.message + error.body).not.toContain('private-test-token');
    expect(error.body).toContain('subscription_sharing_unsupported_capability');
    expect(fetch).toHaveBeenCalledOnce();
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ type: 'response.created', sequence_number: 0, response: initial }])));
    await expect(provider.respond(request)).rejects.toBeInstanceOf(GenerationError);
  });
  it('prevents ChatGPT tokens from being routed to another base URL', () => {
    expect(() => new AuthenticatedResponsesProvider({ baseUrl, chatgpt: true })).toThrow('official OpenAI');
  });
  it('replays encrypted Responses reasoning only within the original model/provider origin', async () => {
    const fetch = vi.fn(async (_url?: unknown, _init?: RequestInit) => json({ ...createResponse('r', request), status: 'completed' })); vi.stubGlobal('fetch', fetch);
    const provider = new AuthenticatedResponsesProvider({ baseUrl });
    const own = { ...origin, module: 'responses' };
    await provider.respond(request, { diagnostic: true, origin: own, context: [record({ type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'ciphertext' }, { origin: own })] });
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body)).input).toHaveLength(1);
    await provider.respond(request, { diagnostic: true, origin: own, context: [record({ type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'ciphertext' }, { origin: { ...own, model: 'different' } })] });
    expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body)).input).toHaveLength(0);
  });
  it('treats a failed terminal Responses event as failure even after output text', async () => {
    const initial = createResponse('r', request);
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => sse([{ type: 'response.created', sequence_number: 0, response: initial },
      { type: 'response.failed', sequence_number: 1, response: { ...initial, status: 'failed', error: { code: 'usage_limit_reached', message: 'Plan limit reached' } } }])));
    await expect(new AuthenticatedResponsesProvider({ baseUrl, forceStream: true }).respond(request, { diagnostic: true })).rejects.toThrow('Plan limit reached');
  });
});

describe('Anthropic Messages', () => {
  it('streams text, signed thinking and partial tools into Responses without executable partial tools', async () => {
    const events = anthropic([], 'tool_use');
    events.splice(1, 0,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Inspect first' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } }, { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-a', name: 'look', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"x":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '4}' } }, { type: 'content_block_stop', index: 2 });
    const fetch = vi.fn(async (_url?: unknown, _init?: RequestInit) => sse(events)); vi.stubGlobal('fetch', fetch);
    const observed: StreamEvent[] = [];
    const result = await new AnthropicMessagesProvider({ baseUrl, apiKey: 'key' }).respond(request, { origin, diagnostic: true, onEvent: event => observed.push(event) });
    expect(result.response.output).toMatchObject([{ type: 'reasoning', encrypted_content: expect.stringMatching(/^anthropic-thinking-v1:/) }, { type: 'message', content: [{ text: '你好' }] }, { type: 'function_call', arguments: '{"x":4}', status: 'completed' }]);
    expect(result.attempts[0].meters).toMatchObject({ input: 17, output: 8, total: 25, cachedInput: 4, reasoning: null });
    expect(fetch.mock.calls[0][1]?.redirect).toBe('error');
    const headers = new Headers((fetch.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('x-api-key')).toBe('key');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('authorization')).toBeNull();
    const body = buildAnthropicBody(request, { origin, context: [message('user', 'look'), ...responseRecords(result.response, origin), functionResult('tool-a', 'Done')] }, { baseUrl, keepThinking: () => false });
    const replay = (body.messages as any[])[1].content;
    expect(replay[0]).toEqual({ type: 'thinking', thinking: 'Inspect first', signature: 'signed' });
    expect(replay[2]).toMatchObject({ type: 'tool_use', input: { x: 4 } });
  });
  it('supports unary text/redacted thinking and tool/image result replay', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => json({ type: 'message', id: 'm', model: 'test-model', content: [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'Done' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } })));
    const result = await new AnthropicMessagesProvider({ baseUrl }).respond(request, { origin, diagnostic: true });
    const body = buildAnthropicBody(request, { origin, context: [...responseRecords(result.response, origin), record({ type: 'function_call_output', call_id: 'a', output: [{ type: 'input_image', image_url: 'data:image/png;base64,cG5n' }] })] }, { baseUrl });
    expect((body.messages as any[])[0].content[0]).toEqual({ type: 'redacted_thinking', data: 'opaque' });
    expect((body.messages as any[])[1].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png' } }] });
    expect(body.max_tokens).toBe(8192);
  });
  it('does not execute incomplete tools even if truncated input happens to parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => sse(anthropic([{ type: 'tool_use', id: 'a', name: 'look', input: { x: 1 } }], 'max_tokens'))));
    const result = await new AnthropicMessagesProvider({ baseUrl }).respond(request, { diagnostic: true, onEvent: () => {} });
    expect(result.response).toMatchObject({ status: 'incomplete', output: [{ status: 'incomplete' }] });
  });
  it('rejects a disconnected stream and never exposes completed tools in partial output', async () => {
    const events = anthropic([{ type: 'tool_use', id: 'a', name: 'look', input: {} }], 'tool_use'); events.pop();
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => sse(events)));
    const error = await new AnthropicMessagesProvider({ baseUrl }).respond(request, { diagnostic: true, onEvent: () => {} }).catch(error => error);
    expect(error).toBeInstanceOf(GenerationError);
    expect(error.message).toContain('message_stop');
    expect(error.partial.output[0].status).toBe('incomplete');
  });
  it('rejects invalid tool JSON on completed generation and malformed event order', async () => {
    const events = anthropic([], 'tool_use');
    events.splice(1, 0, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'look', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } }, { type: 'content_block_stop', index: 0 });
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => sse(events)));
    await expect(new AnthropicMessagesProvider({ baseUrl }).respond(request, { diagnostic: true, onEvent: () => {} })).rejects.toThrow('complete JSON object');
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => sse([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bad' } }])));
    await expect(new AnthropicMessagesProvider({ baseUrl }).respond(request, { diagnostic: true, onEvent: () => {} })).rejects.toThrow('before message_start');
  });
  it('rejects streaming errors and unsupported native server tools', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Busy' } }])));
    await expect(new AnthropicMessagesProvider({ baseUrl }).respond(request, { diagnostic: true, onEvent: () => {} })).rejects.toThrow('Busy');
    vi.stubGlobal('fetch', vi.fn(async (_url?: unknown, _init?: RequestInit) => sse(anthropic([{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }]))));
    await expect(new AnthropicMessagesProvider({ baseUrl }).respond(request, { diagnostic: true, onEvent: () => {} })).rejects.toThrow('Unsupported Anthropic content block');
  });
  it('fails clearly on unsupported input, validates token budgets and maps forced tool selection', () => {
    expect(() => buildAnthropicBody({ ...request, input: [{ type: 'item_reference', id: 'stored' }] }, {}, { baseUrl })).toThrow('cannot replay item_reference');
    expect(() => buildAnthropicBody({ ...request, max_output_tokens: 512, reasoning: { effort: 'high' } }, {}, { baseUrl })).toThrow('greater than 1024');
    const body = buildAnthropicBody({ ...request, max_output_tokens: 2000, reasoning: { effort: 'high' } }, {}, { baseUrl });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1999 });
    expect(buildAnthropicBody({ ...request, tool_choice: 'required' }, {}, { baseUrl }).tool_choice).toEqual({ type: 'any' });
  });
  it('honors cancellation before any request and during fetch', async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => new Promise<globalThis.Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    vi.stubGlobal('fetch', fetch);
    const provider = new AnthropicMessagesProvider({ baseUrl });
    const before = new AbortController(); before.abort();
    await expect(provider.respond(request, { signal: before.signal, diagnostic: true })).rejects.toBeInstanceOf(GenerationError);
    expect(fetch).not.toHaveBeenCalled();
    const during = new AbortController();
    const pending = provider.respond(request, { signal: during.signal, diagnostic: true }).catch(error => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); during.abort();
    expect((await pending).attempts[0].outcome).toBe('aborted');
  });
});
