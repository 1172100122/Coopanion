import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityCatalog, openCodeGoProtocol, parseApiModels, parseChatGPTModels, protocolEndpoint } from '../core/providers/catalog.ts';

afterEach(() => vi.restoreAllMocks());
describe('provider capability catalogs', () => {
  it('preserves account model order and displays only explicitly listed SIWC models', () => {
    const result = parseChatGPTModels({ models: [
      { slug: 'z', display_name: 'Preferred', visibility: 'list', context_window: 128000, max_output_tokens: 8192, input_modalities: ['text', 'image'], supports_reasoning: true },
      { slug: 'hidden', visibility: 'hide' }, { slug: 'unknown', visibility: 'future' }, { slug: 'missing' },
      { slug: 'a', visibility: 'list', input_modalities: ['text'] }, { slug: 'z', visibility: 'list' }, { slug: 7, visibility: 'list' },
    ] });
    expect(result).toEqual([{ id: 'z', displayName: 'Preferred', contextWindow: 128000, maxOutputTokens: 8192, inputImages: true, reasoning: true }, { id: 'a', inputImages: false }]);
  });
  it('parses API-key catalogs without hallucinating unknown capabilities', () => {
    expect(parseApiModels({ data: [
      { id: 'plain' },
      { id: 'metadata', name: 'Friendly', context_length: 200000, top_provider: { max_completion_tokens: 16000 }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'reasoning_effort'] },
      { id: 'negative', context_length: -1, max_output_tokens: 1.5, tool_call: false, reasoning: false, input_images: false },
    ] })).toEqual([{ id: 'plain' }, { id: 'metadata', displayName: 'Friendly', contextWindow: 200000, maxOutputTokens: 16000, inputImages: true, tools: true, reasoning: true },
      { id: 'negative', inputImages: false, tools: false, reasoning: false }]);
  });
  it('does not interpret API models as account models or vice versa', () => {
    expect(() => parseApiModels({ models: [] })).toThrow('data array');
    expect(() => parseChatGPTModels({ data: [] })).toThrow('models array');
  });
  it('refreshes auth once, blocks redirects, and clears stale metadata after failed discovery', async () => {
    let key = 'old';
    const auth = { headers: vi.fn(async () => ({ Authorization: `Bearer ${key}` })), refresh: vi.fn(async () => { key = 'new'; return true; }) };
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(Response.json({ data: [{ id: 'm', context_length: 4096 }] })).mockResolvedValueOnce(new Response('secret value', { status: 500 }));
    const catalog = new CapabilityCatalog({ baseUrl: 'https://example.test/v1/', auth, fetchImpl: fetch });
    expect(await catalog.list()).toEqual([{ id: 'm', contextWindow: 4096 }]);
    expect(catalog.contextWindow('m')).toBe(4096);
    expect(fetch.mock.calls[1][1].redirect).toBe('error');
    expect(new Headers(fetch.mock.calls[1][1].headers).get('authorization')).toBe('Bearer new');
    await expect(catalog.list()).rejects.toThrow('HTTP 500');
    expect(catalog.contextWindow('m')).toBeUndefined();
  });
  it('discovery can use a provider-specific catalog path and preserves cancellation', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => { expect(init?.signal?.aborted).toBe(true); throw new Error('aborted'); });
    const controller = new AbortController(); controller.abort();
    const catalog = new CapabilityCatalog({ baseUrl: 'https://example.test', endpointPath: '/api/models?view=account', fetchImpl: fetch });
    await expect(catalog.list(controller.signal)).rejects.toThrow('aborted');
    expect(fetch.mock.calls[0][0]).toBe('https://example.test/api/models?view=account');
  });
  it('routes Go by documented model rather than treating every model as Chat Completions', () => {
    expect(openCodeGoProtocol('minimax-m2.7')).toBe('anthropic-messages');
    expect(openCodeGoProtocol('kimi-k2.6')).toBe('chat-completions');
    expect(openCodeGoProtocol('glm-5.3')).toBe('chat-completions');
    expect(openCodeGoProtocol('gpt-6-luna')).toBe('responses');
    expect(openCodeGoProtocol('minimax-new-unverified')).toBeUndefined();
    expect(protocolEndpoint('anthropic-messages')).toBe('/messages');
  });
});
