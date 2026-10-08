import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mountConnections, ACCOUNT_PATH, PENDING_MODEL, type AccountState, type ConnectionCall, type ConnectionEntry, type ConnectionModel } from '../console/features/home/connections.ts';

// jsdom is used by the existing lifecycle suite; this narrow shape avoids adding another package.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: Window & typeof globalThis; }
};
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };

function fixture(options: { existing?: Record<string, ConnectionEntry>; override?: (path: string, body?: unknown) => Promise<unknown> | undefined } = {}) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { url: 'http://127.0.0.1:12345/#/home', pretendToBeVisual: true });
  const doc = dom.window.document;
  const controller = new dom.window.AbortController();
  const root = doc.querySelector('main')!;
  const entries = { ...options.existing };
  const states: Record<string, AccountState> = {};
  const catalogs: ConnectionModel[] = [{ id: 'fixture-model', displayName: 'Fixture model', inputImages: true }];
  const calls: Array<{ path: string; body?: unknown; options?: { signal?: AbortSignal; keepalive?: boolean } }> = [];
  let testResult: unknown = { ok: true };
  const request: ConnectionCall = async <T>(path: string, body?: unknown, requestOptions?: { signal?: AbortSignal; keepalive?: boolean }) => {
    calls.push({ path, body, options: requestOptions });
    const override = options.override?.(path, body);
    if (override) return await override as T;
    const payload = body as { name: string; entry: ConnectionEntry; args: Array<{ name: string }> } | undefined;
    if (path === '/api/providers') {
      if (payload) { entries[payload.name] = payload.entry; return { name: payload.name, entry: payload.entry, revision: '1' } as T; }
      return { providers: Object.keys(entries).map((name) => ({ name })) } as T;
    }
    if (path.startsWith(ACCOUNT_PATH)) {
      const name = payload!.args[0]!.name;
      const method = path.slice(ACCOUNT_PATH.length);
      if (method === 'models') return catalogs as T;
      if (method === 'login') states[name] = { status: 'authorizing', message: 'Finish sign-in in your browser.' };
      if (method === 'cancel' || method === 'logout') states[name] = { status: 'signed-out' };
      return (states[name] ?? { status: entries[name]?.options?.service === 'chatgpt' ? 'signed-out' : 'connected' }) as T;
    }
    const name = decodeURIComponent(path.split('/')[3]!);
    if (path.endsWith('/save')) { entries[name] = payload!.entry; return { name, entry: payload!.entry, revision: '2' } as T; }
    if (path.endsWith('/test')) return testResult as T;
    if (path.endsWith('/activate') || path === '/api/run/resume') return {} as T;
    return { name, entry: entries[name], revision: '1' } as T;
  };
  const onActivated = vi.fn();
  const mounted = mountConnections({ root, signal: controller.signal, call: request, language: 'en', onActivated });
  cleanups.push(() => { controller.abort(); mounted.dispose(); dom.window.close(); });
  const action = (name: string) => root.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;
  const input = (name: string) => root.querySelector<HTMLInputElement>(`[data-field="${name}"]`)!;
  const value = (name: string, value: string) => { const el = input(name); el.value = value; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const select = async (name: string) => { action(name).click(); await settle(); };
  return { window: dom.window, doc, root, calls, entries, states, catalogs, action, input, value, select, controller, mounted, onActivated, setTest: (result: unknown) => { testResult = result; } };
}
const entry = (service: string): ConnectionEntry => ({ kind: 'connections', baseUrl: service === 'chatgpt' ? 'https://api.openai.com/v1' : 'https://api.x.ai/v1', spec: { model: 'fixture-model', thinking: false }, options: { service, protocol: 'responses', inputImages: false } });

describe('home provider connections', () => {
  it('makes ChatGPT the primary choice without changing the nine-vendor implementation', async () => {
    const ui = fixture(); await settle();
    expect(ui.action('chatgpt').getAttribute('aria-pressed')).toBe('true');
    expect(ui.action('login').hidden).toBe(false);
    expect(ui.input('key').closest('label')!.hidden).toBe(true);
    expect(ui.calls.filter((call) => call.body)).toEqual([]);
    expect(readFileSync(new URL('../console/features/home/index.ts', import.meta.url), 'utf8')).toContain('const vendorButtons = VENDORS.map');
    expect(readFileSync(new URL('../packages/cortico-provider-coo/src/vendors.ts', import.meta.url), 'utf8').match(/id: '/g)?.length).toBe(9);
  });

  it('creates a keyless placeholder before sign-in and never handles an authorization URL', async () => {
    const ui = fixture(); await settle(); ui.action('login').click(); ui.action('login').click(); await settle();
    expect(ui.entries['chatgpt-plan']).toMatchObject({ kind: 'connections', baseUrl: 'https://api.openai.com/v1', spec: { model: PENDING_MODEL, thinking: false }, options: { service: 'chatgpt', protocol: 'responses' } });
    expect(ui.entries['chatgpt-plan']!.secret).toBeUndefined();
    expect(ui.calls.filter((call) => call.path === ACCOUNT_PATH + 'login')).toHaveLength(1);
    expect(ui.calls.findIndex((call) => call.path === '/api/providers' && call.body)).toBeLessThan(ui.calls.findIndex((call) => call.path.endsWith('/login')));
    expect(ui.calls.some((call) => call.path.endsWith('/models'))).toBe(false);
    expect(ui.root.querySelector('[data-role="account-status"]')!.textContent).toBe('Waiting for browser sign-in');
    expect(ui.action('cancel').hidden).toBe(false);
    expect(ui.root.querySelector('a[href*="authorize"]')).toBeNull();
    expect(ui.root.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('loads authenticated models, preserves explicit selection and activates only after a passing test', async () => {
    vi.useFakeTimers(); const ui = fixture(); await settle(); ui.action('login').click(); await settle();
    ui.states['chatgpt-plan'] = { status: 'connected', account: 'Fixture account', models: [] };
    await vi.advanceTimersByTimeAsync(1500); await settle();
    expect(ui.root.textContent).toContain('Fixture account');
    expect(ui.input('chatgpt-model').value).toBe('');
    expect(ui.action('activate').disabled).toBe(true);
    ui.value('chatgpt-model', 'fixture-model');
    ui.action('activate').click(); await settle();
    expect(ui.entries['chatgpt-plan']!.spec?.model).toBe('fixture-model');
    expect(ui.entries['chatgpt-plan']!.options?.inputImages).toBeUndefined();
    expect(ui.entries['chatgpt-plan']!.multimodal).toBe(true);
    const writes = ui.calls.map((call) => call.path);
    expect(writes.indexOf('/api/providers/chatgpt-plan/test')).toBeLessThan(writes.indexOf('/api/providers/chatgpt-plan/activate'));
    expect(writes.indexOf('/api/providers/chatgpt-plan/activate')).toBeLessThan(writes.indexOf('/api/run/resume'));
    expect(ui.onActivated).toHaveBeenCalledTimes(1);
    expect(ui.action('logout').hidden).toBe(false);
    ui.action('logout').click(); await settle();
    expect(ui.calls.filter((call) => call.path === ACCOUNT_PATH + 'logout')).toHaveLength(1);
    expect(ui.action('activate').disabled).toBe(true);
  });

  it.each([{ ok: false, error: 'fixture rejection' }, {}, null])('does not activate after a failed or ambiguous test (%j)', async (result) => {
    const ui = fixture(); await settle(); await ui.select('xai');
    ui.value('key', 'fixture-key'); ui.value('model', 'fixture-model'); ui.setTest(result);
    ui.action('activate').click(); await settle();
    expect(ui.calls.some((call) => call.path.endsWith('/test'))).toBe(true);
    expect(ui.calls.some((call) => call.path.endsWith('/activate') || call.path === '/api/run/resume')).toBe(false);
    expect(ui.root.querySelector('.msgline.bad')).not.toBeNull();
  });

  it('keeps xAI on its fixed API endpoint, separates billing and disables unsupported subscription login', async () => {
    const ui = fixture(); await settle(); await ui.select('xai');
    expect(ui.action('xai-login').disabled).toBe(true);
    expect(ui.root.textContent).toContain('billed separately from Grok subscriptions');
    expect(ui.input('base').closest('.home-connection-grid')!.getAttribute('hidden')).not.toBeNull();
    ui.value('key', 'fixture-api-key'); ui.action('save').click(); await settle();
    expect(ui.entries['xai-api']).toMatchObject({ baseUrl: 'https://api.x.ai/v1', secret: 'CORTICO_KEY_XAI_API', options: { service: 'xai', protocol: 'responses', inputImages: false } });
    expect(ui.input('key').value).toBe('');
    expect(ui.calls.some((call) => call.path.endsWith('/activate'))).toBe(false);
    ui.value('model', 'fixture-model'); ui.action('activate').click(); await settle();
    expect(ui.entries['xai-api']!.options?.inputImages).toBe(true);
  });

  it('shows Go as unavailable for companionship and never configures, tests, or activates it', async () => {
    const ui = fixture(); await settle(); const before = ui.calls.length; await ui.select('opencode-go');
    expect(ui.root.textContent).toContain('Coding tasks only');
    expect(ui.root.textContent).toContain('Subscription limits');
    expect(ui.action('go-unavailable').disabled).toBe(true);
    expect(ui.action('activate').hidden).toBe(true);
    expect(ui.input('key').closest('label')!.hidden).toBe(true);
    expect(ui.root.querySelector<HTMLAnchorElement>('.home-connection-go a')!.href).toBe('https://opencode.ai/docs/go/');
    ui.action('save').click(); ui.action('activate').click(); ui.action('login').click(); await settle();
    expect(ui.calls).toHaveLength(before);
    expect(ui.entries['opencode-go']).toBeUndefined();
  });

  it.each(['responses', 'chat-completions', 'anthropic-messages'])('saves explicit custom %s protocol and image capability', async (protocol) => {
    const ui = fixture(); await settle(); await ui.select('custom');
    expect(ui.input('images').checked).toBe(false);
    ui.value('base', 'https://example.test/v1/'); ui.value('protocol', protocol); ui.value('key', 'fixture-key');
    ui.input('images').checked = true; ui.value('model', 'custom-model'); ui.action('activate').click(); await settle();
    expect(ui.entries['custom-connection']).toMatchObject({ baseUrl: 'https://example.test/v1', secret: 'CORTICO_KEY_CUSTOM_CONNECTION', options: { service: 'custom', protocol, inputImages: true } });
    expect(ui.calls.some((call) => call.path === '/api/run/resume')).toBe(true);
  });

  it.each(['https://user:secret@example.test', 'https://example.test?api_key=fixture', 'http://remote.test/v1', 'javascript:alert(1)'])('rejects unsafe custom URL %s before a key is saved', async (base) => {
    const ui = fixture(); await settle(); await ui.select('custom');
    ui.value('base', base); ui.value('key', 'fixture-key'); ui.action('save').click(); await settle();
    expect(ui.calls.some((call) => call.path === '/api/providers' && call.body)).toBe(false);
    expect(ui.root.querySelector('.msgline.bad')!.textContent).toContain('HTTPS base URL');
  });

  it('preserves the existing saved key and uses optimistic revisions when choosing another model', async () => {
    const ui = fixture({ existing: { 'xai-api': entry('xai') } }); await settle(); await ui.select('xai');
    ui.value('model', 'new-fixture-model'); ui.action('activate').click(); await settle();
    const write = ui.calls.find((call) => call.path === '/api/providers/xai-api/save')!;
    expect(write.body).toMatchObject({ name: 'xai-api', expectedRevision: '1', entry: { spec: { model: 'new-fixture-model' } } });
    expect(write.body).not.toHaveProperty('secretValue');
  });

  it('cancels host OAuth explicitly when canceling, switching service or unmounting', async () => {
    for (const mode of ['cancel', 'switch', 'unmount']) {
      const ui = fixture(); await settle(); ui.action('login').click(); await settle();
      if (mode === 'cancel') ui.action('cancel').click();
      if (mode === 'switch') await ui.select('xai');
      if (mode === 'unmount') ui.controller.abort();
      await settle();
      expect(ui.calls.some((call) => call.path === ACCOUNT_PATH + 'cancel' && JSON.stringify(call.body) === '{"args":[{"name":"chatgpt-plan"}]}')).toBe(true);
      if (mode !== 'cancel') expect(ui.calls.find((call) => call.path === ACCOUNT_PATH + 'cancel')!.options?.keepalive).toBe(true);
    }
  });

  it('ignores late login results after switching and cancels a late-started host login', async () => {
    const late = deferred<AccountState>();
    const ui = fixture({ override: (path) => path === ACCOUNT_PATH + 'login' ? late.promise : undefined });
    await settle(); ui.action('login').click(); await settle(); await ui.select('custom');
    ui.value('base', 'https://new.example.test');
    late.resolve({ status: 'authorizing', account: 'stale-account', message: 'stale login' }); await settle();
    expect(ui.action('custom').getAttribute('aria-pressed')).toBe('true');
    expect(ui.root.textContent).not.toContain('stale-account');
    expect(ui.root.textContent).not.toContain('stale login');
    expect(ui.input('base').value).toBe('https://new.example.test');
    expect(ui.calls.filter((call) => call.path === ACCOUNT_PATH + 'cancel')).toHaveLength(2);
  });

  it('does not let a stale test activate a newly selected connection or repeat activation', async () => {
    const late = deferred<{ ok: boolean }>();
    const ui = fixture({ override: (path) => path.endsWith('/test') ? late.promise : undefined });
    await settle(); await ui.select('xai'); ui.value('key', 'fixture-key'); ui.value('model', 'fixture-model');
    ui.action('activate').click(); ui.action('activate').click(); await settle();
    await ui.select('custom'); late.resolve({ ok: true }); await settle();
    expect(ui.calls.filter((call) => call.path.endsWith('/test'))).toHaveLength(1);
    expect(ui.calls.some((call) => call.path.endsWith('/activate') || call.path === '/api/run/resume')).toBe(false);
    expect(ui.root.textContent).not.toContain('Connection tested and activated');
  });

  it('stops OAuth polling while hidden and after disposal, but hiding does not cancel sign-in', async () => {
    vi.useFakeTimers(); const ui = fixture(); await settle(); ui.action('login').click(); await settle();
    Object.defineProperty(ui.doc, 'hidden', { configurable: true, value: true });
    ui.doc.dispatchEvent(new ui.window.Event('visibilitychange'));
    const count = ui.calls.length; await vi.advanceTimersByTimeAsync(10_000); await settle();
    expect(ui.calls).toHaveLength(count);
    expect(ui.calls.some((call) => call.path.endsWith('/cancel'))).toBe(false);
    Object.defineProperty(ui.doc, 'hidden', { configurable: true, value: false });
    ui.doc.dispatchEvent(new ui.window.Event('visibilitychange')); await settle();
    expect(ui.calls.some((call) => call.path === ACCOUNT_PATH + 'state')).toBe(true);
    ui.controller.abort(); await settle(); const disposedCount = ui.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); await settle();
    expect(ui.calls).toHaveLength(disposedCount);
    expect(ui.calls.at(-1)?.path).toBe(ACCOUNT_PATH + 'cancel');
  });


  it('offers saved accounts without switching until the user explicitly chooses to use one', async () => {
    const ui = fixture({ existing: { 'chatgpt-plan': entry('chatgpt') } });
    ui.states['chatgpt-plan'] = { status: 'signed-out', accounts: [{ id: 'account-a', label: 'Account A' }, { id: 'account-b', email: 'b@example.test' }] };
    await settle();
    expect(ui.action('switch-account').disabled).toBe(true);
    ui.value('account', 'account-b');
    ui.input('account').dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    expect(ui.calls.some((call) => call.path.endsWith('/login'))).toBe(false);
    ui.action('switch-account').click(); await settle();
    expect(ui.calls.find((call) => call.path === ACCOUNT_PATH + 'login')!.body).toEqual({ args: [{ name: 'chatgpt-plan', accountId: 'account-b' }] });
  });

  it('starts another account only on explicit request', async () => {
    const ui = fixture(); await settle(); ui.action('new-account').click(); await settle();
    expect(ui.calls.find((call) => call.path === ACCOUNT_PATH + 'login')!.body).toEqual({ args: [{ name: 'chatgpt-plan', newAccount: true }] });
  });

  it('requires a separate explicit subscription-usage action after the grant is declined', async () => {
    const ui = fixture({ existing: { 'chatgpt-plan': entry('chatgpt') } });
    ui.states['chatgpt-plan'] = { status: 'connected', authenticated: true, planUsageEnabled: false, account: 'Signed-in account', models: [] };
    await settle();
    expect(ui.action('enable-plan').hidden).toBe(false);
    expect(ui.action('activate').disabled).toBe(true);
    expect(ui.root.textContent).toContain('subscription usage is disabled');
    expect(ui.calls.some((call) => call.path.endsWith('/models') || call.path.endsWith('/login'))).toBe(false);
    ui.action('enable-plan').click(); await settle();
    expect(ui.calls.find((call) => call.path === ACCOUNT_PATH + 'login')!.body).toEqual({ args: [{ name: 'chatgpt-plan', enablePlanUsage: true }] });
  });


  it('ignores an in-flight poll after the page becomes hidden', async () => {
    vi.useFakeTimers(); const late = deferred<AccountState>();
    const ui = fixture({ override: (path) => path === ACCOUNT_PATH + 'state' ? late.promise : undefined });
    await settle(); ui.action('login').click(); await settle();
    await vi.advanceTimersByTimeAsync(1500);
    Object.defineProperty(ui.doc, 'hidden', { configurable: true, value: true });
    ui.doc.dispatchEvent(new ui.window.Event('visibilitychange'));
    late.resolve({ status: 'connected', account: 'Late hidden account', models: [] }); await settle();
    expect(ui.root.textContent).not.toContain('Late hidden account');
    expect(ui.calls.some((call) => call.path.endsWith('/models'))).toBe(false);
    const count = ui.calls.length; await vi.advanceTimersByTimeAsync(10_000); expect(ui.calls).toHaveLength(count);
  });

  it('does not start OAuth after the page unmounts during initial entry creation', async () => {
    const late = deferred<unknown>();
    const ui = fixture({ override: (path, body) => path === '/api/providers' && body ? late.promise : undefined });
    await settle(); ui.action('login').click(); await settle(); ui.controller.abort();
    late.resolve({ name: 'chatgpt-plan', entry: entry('chatgpt'), revision: '1' }); await settle();
    expect(ui.calls.some((call) => call.path.endsWith('/login'))).toBe(false);
  });

  it('retains an unresolved OAuth cancellation so unmount can cancel the host operation', async () => {
    const ui = fixture({ override: (path) => path === ACCOUNT_PATH + 'cancel' ? Promise.reject(new Error('Fixture cancellation failed')) : undefined });
    await settle(); ui.action('login').click(); await settle(); ui.action('cancel').click(); await settle();
    expect(ui.root.textContent).toContain('Fixture cancellation failed');
    ui.controller.abort(); await settle();
    const cancellations = ui.calls.filter((call) => call.path === ACCOUNT_PATH + 'cancel');
    expect(cancellations).toHaveLength(2);
    expect(cancellations.at(-1)?.options?.keepalive).toBe(true);
  });

  it('honors the explicit custom image checkbox even when a generic catalog omits image metadata', async () => {
    const ui = fixture(); await settle(); await ui.select('custom');
    ui.value('base', 'https://example.test/v1'); ui.value('key', 'fixture-key');
    ui.catalogs[0]!.inputImages = false;
    ui.action('save').click(); await settle();
    ui.value('model', 'fixture-model'); ui.input('images').checked = true;
    ui.action('activate').click(); await settle();
    expect(ui.entries['custom-connection']!.options?.inputImages).toBe(true);
  });


  it('persists a selected catalog model’s context cap and clamps its output budget', async () => {
    const previous = entry('xai');
    previous.spec = { model: 'fixture-model', thinking: false, contextWindow: 128_000, maxTokens: 16_384 };
    const ui = fixture({ existing: { 'xai-api': previous } });
    ui.catalogs.push({ id: 'next-model', contextWindow: 64_000, maxOutputTokens: 4096 });
    await settle(); await ui.select('xai'); ui.value('model', 'next-model'); ui.action('activate').click(); await settle();
    expect(ui.entries['xai-api']!.spec).toMatchObject({ model: 'next-model', contextWindow: 64_000, maxTokens: 4096 });
  });

  it('clears the previous context limit when switching to a model without known caps', async () => {
    const previous = entry('xai');
    previous.spec = { model: 'fixture-model', thinking: false, contextWindow: 128_000, maxTokens: 16_384 };
    const ui = fixture({ existing: { 'xai-api': previous } });
    await settle(); await ui.select('xai'); ui.value('model', 'unknown-model'); ui.action('activate').click(); await settle();
    expect(ui.entries['xai-api']!.spec).toMatchObject({ model: 'unknown-model', maxTokens: 16_384 });
    expect(ui.entries['xai-api']!.spec).not.toHaveProperty('contextWindow');
  });

  it('preserves an explicit context limit for the same model when its catalog has no cap', async () => {
    const previous = entry('xai');
    previous.spec = { model: 'fixture-model', thinking: false, contextWindow: 96_000, maxTokens: 2048 };
    const ui = fixture({ existing: { 'xai-api': previous } });
    ui.catalogs[0]!.maxOutputTokens = 8192;
    await settle(); await ui.select('xai'); ui.action('activate').click(); await settle();
    expect(ui.entries['xai-api']!.spec).toMatchObject({ model: 'fixture-model', contextWindow: 96_000, maxTokens: 2048 });
  });

  it('does not overwrite a reserved connection name owned by a different module', async () => {
    const ui = fixture({ existing: { 'xai-api': { ...entry('xai'), kind: 'coo' } } }); await settle(); await ui.select('xai');
    ui.value('key', 'fixture-key'); ui.action('save').click(); await settle();
    expect(ui.calls.some((call) => call.path.endsWith('/save'))).toBe(false);
    expect(ui.root.textContent).toContain('different provider');
  });
});
