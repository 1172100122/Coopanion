import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProviderEntry, CoreConfig } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { createResponse, type Request } from 'cortico/protocol/open-responses/index.ts';
import { createConnections, credentialNamespace, type AccountState, type ConnectionAuth } from '../core/providers/connections.ts';
import { validateConnection, GO_UNAVAILABLE } from '../core/providers/options.ts';
import { connectionReady } from '../core/providers/readiness.ts';

class FakeAuth implements ConnectionAuth {
  controller = new AbortController();
  sessionVersion = 0;
  current: AccountState = { ready: true, authenticated: false, planUsageEnabled: false, pending: false, status: 'signed-out', accounts: [] };
  get sessionSignal() { return this.controller.signal; }
  state() { return this.current; }
  async whenReady() {}
  beginLogin = vi.fn(async (_options?: unknown) => { this.current = { ...this.current, pending: true, status: 'authorizing' }; });
  cancelLogin = vi.fn(() => { this.current = { ...this.current, pending: false, status: this.current.authenticated ? 'connected' : 'signed-out' }; });
  async logout() { this.switchAccount(); }
  getAccessToken = vi.fn(async () => { if (!this.current.authenticated || !this.current.planUsageEnabled) throw new Error('Sign in first.'); return 'private-test-token'; });
  refresh = vi.fn(async () => 'new-test-token');
  async shutdown() { this.cancelLogin(); this.controller.abort(); }
  switchAccount(id?: string) {
    this.controller.abort(); this.controller = new AbortController(); this.sessionVersion++;
    this.current = { ready: true, authenticated: !!id, planUsageEnabled: !!id, pending: false, status: id ? 'connected' : 'signed-out', account: id ? { id, label: 'Fixture account' } : undefined, accounts: id ? [{ id, label: 'Fixture account' }] : [] };
  }
}
const entry = (patch: Partial<LLMProviderEntry> = {}): LLMProviderEntry => ({
  kind: 'connections', baseUrl: 'https://api.openai.com/v1', spec: { model: 'fixture-model', thinking: false }, multimodal: true,
  options: { service: 'chatgpt', protocol: 'responses' }, ...patch,
});
const host = (current: LLMProviderEntry, key = 'test-key') => ({ stateDir: '/tmp/fixture-connections', readBlob: () => Buffer.from('image'), secret: () => key, keepThinking: () => true, log: nullLogger(), currentEntry: () => current });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const models = () => json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list', context_window: 32768, input_modalities: ['text', 'image'] }] });
const request: Request = { model: 'fixture-model', input: 'Hi' };
function completed() {
  const response = { ...createResponse('response-test', request), status: 'completed' };
  return new Response(`data: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: createResponse('response-test', request) })}\n\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 1, response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => vi.unstubAllGlobals());

describe('connection boundaries', () => {
  it('locks subscription credentials to the official protocol and origin', () => {
    expect(() => validateConnection(entry())).not.toThrow();
    for (const patch of [{ baseUrl: 'https://other.test/v1' }, { secret: 'TOKEN' }, { options: { service: 'chatgpt', protocol: 'chat-completions' } }, { options: { service: 'chatgpt', protocol: 'responses', extraHeaders: { Authorization: 'x' } } }, { options: { service: 'chatgpt', protocol: 'responses', inputImages: true } }]) {
      expect(() => validateConnection(entry(patch))).toThrow();
    }
    expect(() => validateConnection(entry({ baseUrl: 'https://api.openai.com/v1?token=private' }))).toThrow();
  });
  it('exposes three custom protocols with HTTPS or loopback only', () => {
    for (const protocol of ['responses', 'chat-completions', 'anthropic-messages']) {
      expect(() => validateConnection(entry({ baseUrl: 'http://127.0.0.1:1234/v1', secret: 'KEY', options: { service: 'custom', protocol } }))).not.toThrow();
    }
    expect(() => validateConnection(entry({ baseUrl: 'http://remote.test/v1', secret: 'KEY', options: { service: 'custom', protocol: 'responses' } }))).toThrow('HTTPS');
  });
  it('cannot activate or run Go in the continuous companion', async () => {
    const service = createConnections({ auth: () => new FakeAuth() });
    const go = entry({ baseUrl: 'https://opencode.ai/zen/go/v1', secret: 'GO_KEY', options: { service: 'opencode-go', protocol: 'chat-completions' } });
    expect(service.module.availability!('go', go, 'en')).toEqual({ ready: false, reason: GO_UNAVAILABLE });
    const instance = service.module.create('go', go, host(go));
    await expect(instance.client.respond(request)).rejects.toThrow('coding');
    await expect(instance.listModels!()).rejects.toThrow('coding');
    expect(() => validateConnection(entry({ ...go, options: { service: 'custom', protocol: 'responses' } }))).toThrow('coding-only');
  });
  it('does not consider a keyless unsigned subscription connection ready', async () => {
    const auth = new FakeAuth();
    const service = createConnections({ auth: () => auth });
    const current = entry();
    const cfg = { providers: { plan: current }, activeProvider: 'plan', language: 'en' } as unknown as CoreConfig;
    expect(connectionReady(cfg, '/tmp/no-provider', () => service.module)).toBe(false);
    auth.switchAccount('a'.repeat(24));
    expect(connectionReady(cfg, '/tmp/no-provider', () => service.module)).toBe(true);
    auth.current.planUsageEnabled = false;
    expect(connectionReady(cfg, '/tmp/no-provider', () => service.module)).toBe(false);
    auth.current.planUsageEnabled = true; auth.current.pending = true;
    expect(connectionReady(cfg, '/tmp/no-provider', () => service.module)).toBe(false);
    auth.current.pending = false; auth.current.status = 'expired';
    expect(connectionReady(cfg, '/tmp/no-provider', () => service.module)).toBe(false);
  });
  it('retains API-key readiness without subscribing or reading OAuth credentials', () => {
    const makeAuth = vi.fn(() => new FakeAuth());
    const service = createConnections({ auth: makeAuth });
    const api = entry({ baseUrl: 'https://api.x.ai/v1', secret: 'KEY', options: { service: 'xai', protocol: 'responses' } });
    const root = mkdtempSync(join(tmpdir(), 'connection-ready-')); mkdirSync(join(root, 'xai')); writeFileSync(join(root, 'xai', '.env'), 'KEY=fixture\n');
    const cfg = { providers: { xai: api }, activeProvider: 'xai', language: 'en' } as unknown as CoreConfig;
    expect(connectionReady(cfg, root, () => service.module)).toBe(true);
    service.module.create('xai', api, host(api));
    expect(makeAuth).not.toHaveBeenCalled();
  });
  it('keeps identity-only login unavailable for inference', async () => {
    const auth = new FakeAuth(); auth.switchAccount('a'.repeat(24)); auth.current.planUsageEnabled = false;
    const service = createConnections({ auth: () => auth, fetch: vi.fn() });
    const instance = service.module.create('plan', entry(), host(entry()));
    await expect(instance.client.respond(request, { diagnostic: true })).rejects.toThrow('Sign in');
  });
});

describe('account-scoped model lifecycle', () => {
  it('caches only the selected account catalog and does not expose tokens in state', async () => {
    const auth = new FakeAuth(); auth.switchAccount('a'.repeat(24));
    const fetchCatalog = vi.fn(async () => models());
    const service = createConnections({ auth: () => auth, fetch: fetchCatalog });
    const current = entry(); const instance = service.module.create('plan', current, host(current));
    await instance.listModels!();
    expect(instance.contextWindow!('fixture-model')).toBe(32768);
    const oldDomain = instance.compatibilityKey!();
    const control = instance.control as { state(): Record<string, unknown>; logout(): Promise<unknown> };
    expect(JSON.stringify(control.state())).not.toContain('private-test-token');
    expect(control.state().models).toHaveLength(1);
    auth.switchAccount('b'.repeat(24));
    expect(instance.compatibilityKey!()).not.toEqual(oldDomain);
    expect(instance.contextWindow!('fixture-model')).toBeUndefined();
    expect(control.state().models).toBeUndefined();
    await control.logout();
    expect(control.state()).toMatchObject({ status: 'signed-out', ready: false, models: [] });
  });
  it('rejects a catalog reply received after account switching', async () => {
    const auth = new FakeAuth(); auth.switchAccount('a'.repeat(24));
    let reply!: (value: Response) => void;
    const catalogReply = new Promise<Response>(resolve => { reply = resolve; });
    const started = vi.fn(() => catalogReply);
    const service = createConnections({ auth: () => auth, fetch: started });
    const instance = service.module.create('plan', entry(), host(entry()));
    const pending = instance.listModels!();
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    auth.switchAccount('b'.repeat(24)); reply(models());
    await expect(pending).rejects.toThrow('Account changed');
  });
  it('drops stale model capabilities after a failed catalog refresh', async () => {
    const auth = new FakeAuth(); auth.switchAccount('a'.repeat(24));
    const fetchCatalog = vi.fn().mockImplementationOnce(async () => models()).mockImplementation(async () => json({}, 503));
    const service = createConnections({ auth: () => auth, fetch: fetchCatalog });
    const instance = service.module.create('plan', entry(), host(entry()));
    await instance.listModels!();
    expect(instance.contextWindow!('fixture-model')).toBe(32768);
    await expect(instance.listModels!()).rejects.toThrow('503');
    expect(instance.contextWindow!('fixture-model')).toBeUndefined();
    expect((instance.control as {state():Record<string,unknown>}).state().models).toBeUndefined();
  });
  it('supports a no-observer completed subscription probe and never reads API-key fallback', async () => {
    const auth = new FakeAuth(); auth.switchAccount('a'.repeat(24));
    const network = vi.fn(async () => completed()); vi.stubGlobal('fetch', network);
    const service = createConnections({ auth: () => auth, fetch: async () => models() });
    const current = entry(); const access = { ...host(current), secret: vi.fn(() => 'paid-api-key') };
    const instance = service.module.create('plan', current, access);
    const result = await instance.client.respond(request, { diagnostic: true });
    expect(result.response.status).toBe('completed');
    expect(access.secret).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('loads xAI image capabilities after a cold start without depending on the settings page', async () => {
    const catalog = vi.fn(async () => json({ data: [{ id: 'fixture-model', input_modalities: ['text', 'image'], context_length: 32768 }] }));
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...createResponse('response-test', request), status: 'completed' })));
    const service = createConnections({ auth: () => new FakeAuth(), fetch: catalog });
    const api = entry({ baseUrl: 'https://api.x.ai/v1', secret: 'KEY', options: { service: 'xai', protocol: 'responses' } });
    const instance = service.module.create('xai', api, host(api));
    await instance.client.respond(request, { diagnostic: true });
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(instance.contextWindow!('fixture-model')).toBe(32768);
  });
  it('pauses on a plan limit, reports safe recovery details and permits an explicit successful retest', async () => {
    const auth = new FakeAuth(); auth.switchAccount('a'.repeat(24));
    const network = vi.fn().mockResolvedValueOnce(json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private-test-token', param: 'model' } }, 429)).mockImplementation(async () => completed());
    vi.stubGlobal('fetch', network);
    const onBlocked = vi.fn();
    const service = createConnections({ auth: () => auth, fetch: async () => models(), onBlocked });
    const current = entry(); const instance = service.module.create('plan', current, host(current));
    const error = await instance.client.respond(request, { diagnostic: true }).catch(error => error);
    expect(error.message).toContain('subscription_sharing_usage_limit_exceeded');
    expect(error.message).not.toContain('private-test-token');
    expect(onBlocked).toHaveBeenCalledWith('plan');
    expect(service.module.availability!('plan', current, 'en').ready).toBe(false);
    await expect(instance.client.respond(request)).rejects.toThrow('limited');
    expect(network).toHaveBeenCalledTimes(1);
    await instance.client.respond(request, { diagnostic: true });
    expect(service.module.availability!('plan', current, 'en').ready).toBe(true);
  });
  it('validates account control arguments and exposes explicit reconsent and account switching', async () => {
    const auth = new FakeAuth(); const service = createConnections({ auth: () => auth });
    const current = entry(); const instance = service.module.create('plan', current, host(current));
    const contribution = service.module.console!({ language: 'en', entries: () => [{ name: 'plan', entry: current }], instance: () => instance, save: () => {} });
    await contribution.invoke!('accounts', 'login', [{ name: 'plan', accountId: 'a'.repeat(24), enablePlanUsage: true }]);
    expect(auth.beginLogin).toHaveBeenCalledWith({ accountId: 'a'.repeat(24), newAccount: false, enablePlanUsage: true });
    await expect(contribution.invoke!('accounts', 'login', [{ name: 'plan', accountId: '../../other' }])).rejects.toThrow('Invalid saved account');
    const preview = service.module.console!({ language: 'en', editing: true, entries: () => [{ name: 'plan', entry: current }], instance: () => instance, save: () => {} });
    await expect(preview.invoke!('accounts', 'login', [{ name: 'plan' }])).rejects.toThrow('Save');
  });
  it('derives safe private credential namespaces from arbitrary endpoint names', () => {
    expect(credentialNamespace('../private')).toMatch(/^coopanion-chatgpt-[a-f0-9]{64}$/);
    expect(credentialNamespace('one')).not.toBe(credentialNamespace('two'));
  });
});
