import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTAuth, createLoopbackListener, type CallbackResult, type ChatGPTAuthOptions } from '../core/providers/chatgpt-auth.ts';
import type { CredentialStore } from '../core/providers/credential-client.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
const NOW = 1_790_000_000_000;
const ISSUER = 'https://auth.openai.com';
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const REVOKE = `${ISSUER}/oauth/revoke`;
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const created: ChatGPTAuth[] = [];
afterEach(() => { for (const auth of created.splice(0)) auth.cancelLogin(); });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
function storeFixture() {
  const values = new Map<string, string>();
  const store: CredentialStore = { read: vi.fn(async key => values.get(key) ?? null), write: vi.fn(async (key, value) => { values.set(key, value); }), delete: vi.fn(async key => { values.delete(key); }) };
  return { values, store };
}
function fixture(options: Partial<ChatGPTAuthOptions> = {}) {
  const stored = storeFixture();
  const browser: URL[] = [];
  const callbacks: ((url: URL) => Promise<CallbackResult>)[] = [];
  const close = vi.fn();
  let now = NOW;
  let claims: Record<string, unknown> = {};
  let tokenExtra: Record<string, unknown> = {};
  let signer = privateKey;
  let keyId = 'test-key';
  let response: ((body: URLSearchParams) => Promise<Response>) | undefined;
  const jwt = (client: string, nonce: string) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: keyId })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: ISSUER, sub: 'subject-1', aud: client, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, nonce, email: 'person@example.test', ...claims })).toString('base64url');
    return `${header}.${payload}.${sign('sha256', Buffer.from(`${header}.${payload}`), signer).toString('base64url')}`;
  };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href === DISCOVERY) return Response.json({ issuer: ISSUER, jwks_uri: JWKS, revocation_endpoint: REVOKE });
    if (href === JWKS) return Response.json({ keys: [jwk] });
    if (href === REVOKE) return new Response(null, { status: 200 });
    if (href !== TOKEN) throw new Error(`Unexpected fake endpoint: ${href}`);
    const body = new URLSearchParams(init!.body as URLSearchParams);
    if (response) return response(body);
    return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'Bearer', expires_in: 3600, scope,
      id_token: jwt(body.get('client_id')!, browser.at(-1)!.searchParams.get('nonce')!), ...tokenExtra });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const auth = new ChatGPTAuth({ store: stored.store, fetch: fetcher, now: () => now, sleep: async () => {},
    openExternal: async url => { browser.push(new URL(url)); }, createListener: async cb => { callbacks.push(cb); return { redirectUri: `http://127.0.0.1:${41000 + callbacks.length}/auth/callback`, close }; }, ...options });
  created.push(auth);
  const callback = async (params: Record<string, string | undefined> = {}, index = callbacks.length - 1) => {
    const url = new URL(browser[index].searchParams.get('redirect_uri')!);
    const fields = { code: 'test-code', state: browser[index].searchParams.get('state')!, client_id: 'oaiapp_coopanion-test', ...params };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) url.searchParams.set(key, value);
    return callbacks[index](url);
  };
  const login = async () => { await auth.beginLogin(); expect((await callback()).status).toBe(200); };
  return { auth, browser, callbacks, callback, login, fetcher, stored, close, jwt,
    setKeyId: (value: string) => { keyId = value; },
    advance: (ms: number) => { now += ms; }, setClaims: (value: Record<string, unknown>) => { claims = value; },
    setToken: (value: Record<string, unknown>) => { tokenExtra = value; }, setSigner: () => { signer = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey; },
    respond: (fn: (body: URLSearchParams) => Promise<Response>) => { response = fn; },
  };
}
const exchanges = (f: ReturnType<typeof fixture>) => f.fetcher.mock.calls.filter(([url]) => url === TOKEN);

describe('ChatGPT public subscription authentication', () => {
  it('is unready until protected storage loads and uses its own stable host, dynamic registration, PKCE and public scope', async () => {
    const f = fixture();
    expect(f.auth.state()).toMatchObject({ ready: false, authenticated: false });
    await f.auth.beginLogin();
    const url = f.browser[0];
    expect(url.origin + url.pathname).toBe(`${ISSUER}/api/accounts/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'dynamic_agent_client', agent_name_hint: 'Coopanion', resource: 'https://api.openai.com/v1', scope, code_challenge_method: 'S256' });
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    await f.callback();
    const body = new URLSearchParams(exchanges(f)[0][1].body);
    expect(body.get('client_id')).toBe('oaiapp_coopanion-test');
    expect(body.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
    expect(body.has('client_secret')).toBe(false);
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(f.auth.state()).toMatchObject({ ready: true, authenticated: true, planUsageEnabled: true, pending: false, status: 'connected' });
    expect(JSON.stringify(f.auth.state())).not.toMatch(/test-access|test-refresh|idToken|clientId|subject-1/);
    expect(await f.auth.getAccessToken()).toBe('test-access');
    const next = fixture({ store: f.stored.store });
    await next.auth.whenReady();
    await next.auth.beginLogin();
    expect(next.browser[0].searchParams.get('ext_agent_host_id')).toBe(url.searchParams.get('ext_agent_host_id'));
    expect(next.browser[0].searchParams.get('client_id')).toBe('oaiapp_coopanion-test');
    expect(next.browser[0].searchParams.has('agent_name_hint')).toBe(false);
    expect(next.browser[0].searchParams.has('id_token_hint')).toBe(true);
    expect((await next.callback({ client_id: undefined })).status).toBe(200);
  });

  it('fails closed when secure storage cannot load without opening a browser', async () => {
    const f = fixture({ store: { read: async () => { throw new Error('secret in raw error'); }, write: async () => {}, delete: async () => {} } });
    await expect(f.auth.beginLogin()).rejects.toThrow(/keychain/);
    expect(f.browser).toHaveLength(0);
    expect(f.auth.state()).toMatchObject({ ready: false, status: 'error' });
    expect(JSON.stringify(f.auth.state())).not.toContain('secret in raw error');
  });

  it.each([
    { state: 'wrong' }, { state: undefined }, { client_id: undefined }, { client_id: 'dynamic_agent_client' }, { code: undefined },
    { error: 'access_denied' }, { error: 'server-secret', state: 'wrong' },
  ])('rejects malformed or denied callbacks before token exchange: %j', async params => {
    const f = fixture(); await f.auth.beginLogin();
    expect((await f.callback(params)).status).toBe(400);
    expect(exchanges(f)).toHaveLength(0);
    expect(f.auth.state().authenticated).toBe(false);
    expect((await f.callback()).status).toBe(400);
    expect(f.auth.state().error).not.toContain('server-secret');
  });

  it.each([
    { iss: 'https://attacker.invalid' }, { aud: 'different-client' }, { exp: NOW / 1000 - 10 },
    { nonce: 'wrong-nonce' }, { sub: '' }, { iat: NOW / 1000 + 120 },
    { aud: ['oaiapp_coopanion-test', 'other'] }, { azp: 'other' }, { nbf: NOW / 1000 + 60 },
  ])('rejects invalid signed identity claims: %j', async claims => {
    const f = fixture(); f.setClaims(claims); await f.auth.beginLogin();
    expect((await f.callback()).status).toBe(400);
    expect(f.auth.state().authenticated).toBe(false);
  });

  it('rejects bad JWT signatures even when every claim looks valid', async () => {
    const f = fixture(); f.setSigner(); await f.auth.beginLogin();
    expect((await f.callback()).status).toBe(400);
    expect(f.auth.state().authenticated).toBe(false);
  });

  it('keeps sign-in without direct scope but never grants inference from callback scope', async () => {
    const f = fixture(); f.setToken({ scope: 'openid profile email' });
    await f.auth.beginLogin(); expect((await f.callback({ scope })).status).toBe(200);
    expect(f.auth.state()).toMatchObject({ authenticated: true, planUsageEnabled: false });
    await expect(f.auth.getAccessToken()).rejects.toThrow(/not enabled/);
  });

  it('retains verified identity-only sign-in when plan usage is absent', async () => {
    const f = fixture();
    f.setToken({ access_token: undefined, refresh_token: undefined, token_type: undefined, expires_in: undefined, scope: undefined });
    await f.auth.beginLogin(); expect((await f.callback()).status).toBe(200);
    expect(f.auth.state()).toMatchObject({ authenticated: true, planUsageEnabled: false });
    await expect(f.auth.getAccessToken()).rejects.toThrow(/not enabled/);
    const restarted = fixture({ store: f.stored.store }); await restarted.auth.whenReady();
    expect(restarted.auth.state()).toMatchObject({ authenticated: true, planUsageEnabled: false });
  });

  it('rejects a changed client or subject on returning sign-in without replacing the active account', async () => {
    const f = fixture(); await f.login(); const account = f.auth.state().account;
    await f.auth.beginLogin(); expect((await f.callback({ client_id: 'oaiapp_different' })).status).toBe(400);
    expect(exchanges(f)).toHaveLength(1);
    f.setClaims({ sub: 'subject-2' }); await f.auth.beginLogin();
    expect((await f.callback()).status).toBe(400);
    expect(f.auth.state().account).toEqual(account);
    expect(await f.auth.getAccessToken()).toBe('test-access');
  });

  it('keeps distinct client+subject registrations even with the same email', async () => {
    const f = fixture(); await f.login(); const first = f.auth.state().account;
    await f.auth.beginLogin({ newAccount: true });
    expect((await f.callback({ client_id: 'oaiapp_second' })).status).toBe(200);
    expect(f.auth.state().accounts).toHaveLength(2);
    expect(f.auth.state().account!.id).not.toBe(first!.id);
    await f.auth.beginLogin({ accountId: first!.id });
    expect(f.browser.at(-1)!.searchParams.get('client_id')).toBe('oaiapp_coopanion-test');
  });

  it('immediately aborts the old session when account switching starts and preserves credentials on cancel', async () => {
    const f = fixture(); await f.login();
    const oldSignal = f.auth.sessionSignal; const oldVersion = f.auth.sessionVersion; const account = f.auth.state().account;
    const switching = f.auth.beginLogin({ newAccount: true });
    expect(oldSignal.aborted).toBe(true);
    expect(f.auth.sessionVersion).toBeGreaterThan(oldVersion);
    await switching;
    expect(f.auth.state()).toMatchObject({ pending: true, account });
    f.auth.cancelLogin();
    expect(f.auth.state()).toMatchObject({ authenticated: true, pending: false, account });
    expect(await f.auth.getAccessToken()).toBe('test-access');
    expect(oldSignal.aborted).toBe(true);
    expect(f.auth.sessionSignal.aborted).toBe(false);
  });

  it('singleflights refresh and persists rotated credentials together before returning a token', async () => {
    const f = fixture(); await f.login(); const version = f.auth.sessionVersion; f.advance(3_550_000);
    const gate = deferred<Response>(); f.respond(async () => gate.promise);
    const first = f.auth.getAccessToken(); const second = f.auth.getAccessToken();
    await vi.waitFor(() => expect(exchanges(f)).toHaveLength(2));
    const body = new URLSearchParams(exchanges(f)[1][1].body);
    expect(Object.fromEntries(body)).toEqual({ grant_type: 'refresh_token', client_id: 'oaiapp_coopanion-test', refresh_token: 'test-refresh', resource: 'https://api.openai.com/v1' });
    gate.resolve(Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', scope, expires_in: 3600 }));
    expect(await Promise.all([first, second])).toEqual(['rotated-access', 'rotated-access']);
    const record = JSON.parse(f.stored.values.get('chatgpt-auth-v1')!);
    expect(record.accounts[0].tokens).toMatchObject({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' });
    expect(f.auth.sessionVersion).toBe(version);
  });

  it('preserves credentials on transient refresh errors and clears only unusable tokens on terminal errors', async () => {
    const f = fixture(); await f.login();
    f.respond(async () => Response.json({ error: { code: 'server_error', message: 'secret' } }, { status: 503 }));
    await expect(f.auth.refresh()).rejects.toThrow(/later/);
    expect(f.auth.state().authenticated).toBe(true);
    f.respond(async () => Response.json({ error: 'invalid_grant', error_description: 'private diagnostic' }, { status: 400 }));
    await expect(f.auth.refresh()).rejects.toThrow(/expired/);
    expect(f.auth.state()).toMatchObject({ authenticated: false });
    expect(f.auth.state().accounts).toHaveLength(1);
    expect(JSON.stringify(f.auth.state())).not.toMatch(/secret|private diagnostic/);
    await f.auth.beginLogin(); expect(f.browser.at(-1)!.searchParams.get('client_id')).toBe('oaiapp_coopanion-test');
  });

  it('consumes a callback once and prevents cancellation or restart from accepting stale code exchange', async () => {
    const f = fixture(); await f.auth.beginLogin();
    const gate = deferred<Response>(); f.respond(async () => gate.promise);
    const old = f.callback();
    await vi.waitFor(() => expect(exchanges(f)).toHaveLength(1));
    expect((await f.callback()).status).toBe(400);
    f.auth.cancelLogin(); await f.auth.beginLogin();
    gate.resolve(Response.json({ access_token: 'late-secret', refresh_token: 'late-refresh', token_type: 'Bearer', expires_in: 3600, scope, id_token: f.jwt('oaiapp_coopanion-test', f.browser[0].searchParams.get('nonce')!) }));
    expect((await old).status).toBe(400);
    expect(f.auth.state()).toMatchObject({ authenticated: false, pending: true });
    expect(f.stored.values.get('chatgpt-auth-v1') ?? '').not.toContain('late-secret');
  });

  it('compensates a cancelled callback whose secure storage write was already in flight', async () => {
    const f = fixture(); await f.auth.beginLogin();
    const gate = deferred<void>(); const originalWrite = f.stored.store.write;
    let blocked = false;
    f.stored.store.write = async (key, value) => {
      if (key === 'chatgpt-auth-v1' && !blocked) { blocked = true; await gate.promise; }
      await originalWrite(key, value);
    };
    const callback = f.callback(); await vi.waitFor(() => expect(blocked).toBe(true));
    f.auth.cancelLogin(); gate.resolve(); await callback;
    expect(f.auth.state().authenticated).toBe(false);
    expect(f.stored.values.get('chatgpt-auth-v1')).not.toContain('test-access');
    const restart = fixture({ store: f.stored.store }); await restart.auth.whenReady();
    expect(restart.auth.state().authenticated).toBe(false);
  });

  it('logout aborts the session, revokes the issued refresh token and preserves registration and host without hints', async () => {
    const f = fixture(); await f.login(); const signal = f.auth.sessionSignal; const host = f.browser[0].searchParams.get('ext_agent_host_id');
    await f.auth.logout(); expect(signal.aborted).toBe(true);
    expect(f.auth.state()).toMatchObject({ authenticated: false, remoteRevocationConfirmed: true });
    const revoke = f.fetcher.mock.calls.find(([url]) => url === REVOKE);
    expect(Object.fromEntries(new URLSearchParams(revoke![1].body))).toEqual({ token: 'test-refresh', token_type_hint: 'refresh_token', client_id: 'oaiapp_coopanion-test' });
    expect(f.stored.values.get('chatgpt-auth-v1')).not.toMatch(/test-access|test-refresh|idToken/);
    await f.auth.beginLogin();
    expect(f.browser.at(-1)!.searchParams.get('client_id')).toBe('oaiapp_coopanion-test');
    expect(f.browser.at(-1)!.searchParams.get('ext_agent_host_id')).toBe(host);
    expect(f.browser.at(-1)!.searchParams.has('id_token_hint')).toBe(false);
  });

  it('late refresh after logout cannot resurrect credentials or change the new session', async () => {
    const f = fixture(); await f.login();
    const gate = deferred<Response>(); f.respond(async () => gate.promise);
    const refresh = f.auth.refresh().catch(error => error);
    await vi.waitFor(() => expect(exchanges(f)).toHaveLength(2));
    await f.auth.logout();
    gate.resolve(Response.json({ access_token: 'late-access', refresh_token: 'late-refresh', token_type: 'Bearer', scope, expires_in: 3600 }));
    expect(await refresh).toBeInstanceOf(Error);
    expect(f.auth.state().authenticated).toBe(false);
    expect(f.stored.values.get('chatgpt-auth-v1')).not.toContain('late-access');
  });

  it('cancel during logout cannot interrupt revocation or leave durable credentials behind', async () => {
    const f = fixture(); await f.login(); const revoke = deferred<Response>();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (target: string, init: RequestInit) => target === REVOKE ? revoke.promise : original(target, init));
    const logout = f.auth.logout();
    await vi.waitFor(() => expect(f.fetcher.mock.calls.some(([target]) => target === REVOKE)).toBe(true));
    f.auth.cancelLogin(); revoke.resolve(new Response(null, { status: 200 }));
    await logout; expect(f.auth.state()).toMatchObject({ authenticated: false, remoteRevocationConfirmed: true });
    expect(f.stored.values.get('chatgpt-auth-v1')).not.toContain('test-refresh');
  });

  it('retries remote revocation once then explains local-only sign-out without leaking diagnostics', async () => {
    const f = fixture(); await f.login(); const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (target: string, init: RequestInit) => target === REVOKE ? new Response('private upstream secret', { status: 503 }) : original(target, init));
    await f.auth.logout();
    expect(f.fetcher.mock.calls.filter(([target]) => target === REVOKE)).toHaveLength(2);
    expect(f.auth.state()).toMatchObject({ authenticated: false, remoteRevocationConfirmed: false });
    expect(f.auth.state().error).toMatch(/Remote revocation was not confirmed/);
    expect(f.auth.state().error).not.toContain('private upstream secret');
    expect(f.stored.values.get('chatgpt-auth-v1')).not.toContain('test-refresh');
  });

  it('does not replay a rotated refresh token when durable rotation fails', async () => {
    const f = fixture(); await f.login(); const original = f.stored.store.write;
    let failed = false;
    f.stored.store.write = async (key, value) => {
      if (key === 'chatgpt-auth-v1' && !failed) { failed = true; throw new Error('Disk locked'); }
      await original(key, value);
    };
    f.setToken({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
    await expect(f.auth.refresh()).rejects.toThrow(/saved securely/);
    expect(f.auth.state().authenticated).toBe(false);
    expect(f.stored.values.get('chatgpt-auth-v1')).not.toMatch(/test-refresh|rotated-refresh/);
    expect(f.auth.state().accounts).toHaveLength(1);
  });

  it('rolls back an uncertain successful IPC write before reporting storage failure', async () => {
    const f = fixture(); await f.auth.beginLogin(); const original = f.stored.store.write;
    let failed = false;
    f.stored.store.write = async (key, value) => {
      await original(key, value);
      if (key === 'chatgpt-auth-v1' && !failed) { failed = true; throw new Error('Timed out after atomic commit'); }
    };
    expect((await f.callback()).status).toBe(400);
    expect(f.auth.state().authenticated).toBe(false);
    expect(f.stored.values.get('chatgpt-auth-v1')).not.toContain('test-access');
  });

  it('shutdown drains a cancelled in-flight write before the caller can dispose credential IPC', async () => {
    const f = fixture(); await f.auth.beginLogin(); const gate = deferred<void>(); const original = f.stored.store.write;
    let writing = false;
    f.stored.store.write = async (key, value) => { if (key === 'chatgpt-auth-v1' && !writing) { writing = true; await gate.promise; } await original(key, value); };
    const callback = f.callback(); await vi.waitFor(() => expect(writing).toBe(true));
    let drained = false; const shutdown = f.auth.shutdown().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    gate.resolve(); await Promise.all([callback, shutdown]);
    expect(f.stored.values.get('chatgpt-auth-v1')).not.toContain('test-access');
  });

  it('rejects a mismatched callback origin/path and a duplicate state before any exchange', async () => {
    for (const change of [
      (u: URL) => { u.hostname = 'localhost'; }, (u: URL) => { u.pathname = '/callback'; },
      (u: URL) => { u.searchParams.append('state', u.searchParams.get('state')!); },
    ]) {
      const f = fixture(); await f.auth.beginLogin(); const callback = new URL(f.browser[0].searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ code: 'code', state: f.browser[0].searchParams.get('state')!, client_id: 'oaiapp_coopanion-test' }).toString();
      change(callback); expect((await f.callbacks[0](callback)).status).toBe(400); expect(exchanges(f)).toHaveLength(0);
    }
  });

  it('pins discovery issuer and never sends token material to a discovery-controlled foreign origin', async () => {
    const f = fixture(); const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (target: string, init: RequestInit) => target === DISCOVERY ? Response.json({ issuer: ISSUER, jwks_uri: 'https://attacker.invalid/keys' }) : original(target, init));
    await f.auth.beginLogin(); expect((await f.callback()).status).toBe(400);
    expect(f.fetcher.mock.calls.some(([target]) => String(target).includes('attacker.invalid'))).toBe(false);
  });

  it('reuses issued registration after an invalid authorization grant and never saves the dynamic entrypoint', async () => {
    const f = fixture(); f.respond(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    await f.auth.beginLogin(); expect((await f.callback()).status).toBe(400);
    await f.auth.beginLogin(); expect(f.browser.at(-1)!.searchParams.get('client_id')).toBe('oaiapp_coopanion-test');
    expect(f.browser.at(-1)!.searchParams.has('agent_name_hint')).toBe(false);
    expect(f.stored.values.get('chatgpt-auth-v1') ?? '').not.toContain('dynamic_agent_client');
  });

  it('refreshes cached JWKS once when a new signing key ID appears', async () => {
    const f = fixture(); await f.login(); f.setKeyId('rotated-key');
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (target: string, init: RequestInit) => target === JWKS ? Response.json({ keys: [{ ...jwk, kid: 'rotated-key' }] }) : original(target, init));
    await f.auth.beginLogin(); expect((await f.callback()).status).toBe(200);
    expect(f.fetcher.mock.calls.filter(([target]) => target === JWKS)).toHaveLength(2);
  });

  it('real loopback listener filters host, origin, path and method, then closes cleanly', async () => {
    const callback = vi.fn(async () => ({ status: 200, message: 'Fixture callback accepted.' }));
    const listener = await createLoopbackListener(callback); const target = new URL(listener.redirectUri);
    const local = (path: string, method = 'GET', headers: Record<string, string> = {}): Promise<number> => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: target.port, path, method, agent: false, headers }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode!));
      });
      req.on('error', reject); req.end();
    });
    try {
      expect(await local('/auth/callback?state=fixture')).toBe(200);
      expect(await local('/elsewhere')).toBe(400);
      expect(await local('/auth/callback', 'POST')).toBe(400);
      expect(await local('/auth/callback', 'GET', { Host: `localhost:${target.port}` })).toBe(400);
      expect(await local('/auth/callback', 'GET', { Origin: 'https://attacker.invalid' })).toBe(400);
      expect(await local('http://attacker.invalid/auth/callback')).toBe(400);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally { listener.close(); }
    await expect(local('/auth/callback')).rejects.toThrow();
  });

  it('isolates endpoint records but shares a stable runtime host identity', async () => {
    const stored = storeFixture();
    const first = fixture({ store: stored.store, storeKey: 'auth-chatgpt-one' });
    const second = fixture({ store: stored.store, storeKey: 'auth-chatgpt-two' });
    await Promise.all([first.auth.beginLogin(), second.auth.beginLogin()]);
    expect(first.browser[0].searchParams.get('ext_agent_host_id')).toBe(second.browser[0].searchParams.get('ext_agent_host_id'));
    await first.callback(); expect(second.auth.state().authenticated).toBe(false);
    expect(stored.values.has('auth-chatgpt-one')).toBe(true);
    expect(stored.values.has('auth-chatgpt-two')).toBe(false);
  });
});
