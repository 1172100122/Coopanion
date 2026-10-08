/**
 * Coopanion's own public OAuth client, using OpenAI's documented direct ChatGPT-plan flow.
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * Tokens stay in Core and the OS-encrypted main-process broker, never endpoint config or UI.
 */
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import { createServer } from 'node:http';
import type { CredentialStore } from './credential-client.ts';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const HOST_KEY = 'coopanion-host-v1';
const LOGIN_LIFETIME = 10 * 60_000;
const TERMINAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const hostIds = new WeakMap<CredentialStore, Promise<string>>();

export interface ChatGPTAccount {
  id: string;
  label: string;
  email?: string;
}
export interface ChatGPTAuthState {
  ready: boolean;
  authenticated: boolean;
  planUsageEnabled: boolean;
  pending: boolean;
  status: 'signed-out' | 'authorizing' | 'connected' | 'expired' | 'error';
  error?: string;
  account?: ChatGPTAccount;
  accounts: ChatGPTAccount[];
  sessionVersion: number;
  remoteRevocationConfirmed?: boolean;
}
export interface CallbackResult { status: number; message: string }
export interface CallbackListener { redirectUri: string; close(): void }
export interface ChatGPTAuthOptions {
  store: CredentialStore;
  storeKey?: string;
  openExternal(url: string): Promise<void> | void;
  fetch?: typeof fetch;
  now?: () => number;
  onChange?(state: ChatGPTAuthState): void;
  /** Injectable transport only, never an endpoint-configurable OAuth origin. */
  createListener?(handler: (url: URL) => Promise<CallbackResult>): Promise<CallbackListener>;
  loginTimeoutMs?: number;
  requestTimeoutMs?: number;
  sleep?(milliseconds: number): Promise<void>;
}
interface Tokens {
  accessToken?: string;
  refreshToken?: string;
  idToken: string;
  nonce: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: string[];
}
interface Registration extends ChatGPTAccount { clientId: string; subject: string; tokens?: Tokens }
interface Saved { version: 1; active?: string; accounts: Registration[] }
interface Pending {
  generation: number;
  state: string;
  nonce: string;
  verifier: string;
  clientId: string;
  account?: Registration;
  redirectUri?: string;
  listener?: CallbackListener;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  consumed: boolean;
}
interface Discovery { issuer: string; jwks_uri: string; revocation_endpoint?: string }
interface Identity { sub: string; email?: string; nonce?: string }
class AuthError extends Error {
  constructor(message: string, readonly code = 'auth_error') { super(message); }
}
const safeMessage = (error: unknown) => error instanceof AuthError ? error.message : 'ChatGPT sign-in could not be completed. Try again.';
const textField = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100_000;
const issuedClient = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(value) && value !== 'dynamic_agent_client';
const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const accountId = (clientId: string, sub: string) => createHash('sha256').update(JSON.stringify([ISSUER, clientId, sub])).digest('hex').slice(0, 24);
const publicAccount = ({ id, label, email }: Registration): ChatGPTAccount => ({ id, label, ...(email ? { email } : {}) });

/** A fixed 127.0.0.1 callback, with an ephemeral port and no ambient HTTP/renderer routing. */
export async function createLoopbackListener(handler: (url: URL) => Promise<CallbackResult>): Promise<CallbackListener> {
  let redirectUri = '';
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let url: URL;
    try { url = new URL(req.url ?? '', redirectUri); }
    catch { res.writeHead(400).end('Invalid callback.'); return; }
    const expected = new URL(redirectUri);
    if (req.method !== 'GET' || req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== expected.host
      || url.origin !== expected.origin || url.pathname !== expected.pathname || (req.headers.origin && req.headers.origin !== ISSUER)) {
      res.writeHead(400).end('Invalid callback.'); return;
    }
    void handler(url).then((result) => res.writeHead(result.status).end(result.message), () => res.writeHead(400).end('Sign-in could not be completed. Return to Coopanion.'));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.on('error', () => {}); // Runtime errors must not dump callback URLs to stderr.
  redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/auth/callback`;
  return { redirectUri, close: () => { server.close(); server.closeIdleConnections(); } };
}

export class ChatGPTAuth {
  private saved: Saved = { version: 1, accounts: [] };
  private hostId = '';
  private ready = false;
  private error?: string;
  private pending?: Pending;
  private generation = 0;
  private version = 0;
  private sessionController = new AbortController();
  private readonly requests = new Set<AbortController>();
  private readonly http: typeof fetch;
  private readonly now: () => number;
  private readonly loaded: Promise<void>;
  private persistQueue: Promise<void> = Promise.resolve();
  private refreshing?: Promise<string>;
  private signingOut?: Promise<ChatGPTAuthState>;
  private retryClientId?: string;
  private discovery?: Discovery;
  private jwks?: { keys: (JsonWebKey & { kid?: string; alg?: string; use?: string; key_ops?: string[] })[]; expiresAt: number };
  private remoteRevocationConfirmed?: boolean;

  constructor(private readonly options: ChatGPTAuthOptions) {
    this.http = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.loaded = this.load();
    void this.loaded.catch(() => {});
  }
  get sessionSignal(): AbortSignal { return this.sessionController.signal; }
  get sessionVersion(): number { return this.version; }
  whenReady(): Promise<void> { return this.loaded; }
  private get key(): string { return this.options.storeKey ?? 'chatgpt-auth-v1'; }
  private get active(): Registration | undefined { return this.saved.accounts.find(account => account.id === this.saved.active); }

  state(): ChatGPTAuthState {
    const active = this.active;
    const authenticated = !!active?.tokens && !this.signingOut;
    const planUsageEnabled = !!active?.tokens?.scopes.includes(DIRECT_SCOPE);
    const expired = authenticated && active!.tokens!.expiresAt <= this.now() && !active!.tokens!.refreshToken;
    return {
      ready: this.ready,
      authenticated,
      planUsageEnabled,
      pending: !!this.pending,
      status: this.pending ? 'authorizing' : this.error ? 'error' : expired ? 'expired' : authenticated ? 'connected' : 'signed-out',
      ...(this.error ? { error: this.error } : {}),
      ...(active ? { account: publicAccount(active) } : {}),
      accounts: this.saved.accounts.map(publicAccount),
      sessionVersion: this.version,
      ...(this.remoteRevocationConfirmed !== undefined ? { remoteRevocationConfirmed: this.remoteRevocationConfirmed } : {}),
    };
  }
  private notify(): void { try { this.options.onChange?.(this.state()); } catch { /* observers cannot break auth */ } }
  private sessionChanged(): void {
    this.version++;
    this.sessionController.abort();
    this.sessionController = new AbortController();
  }
  private async load(): Promise<void> {
    try {
      let host = hostIds.get(this.options.store);
      if (!host) {
        host = (async () => {
          const stored = await this.options.store.read(HOST_KEY);
          if (stored && /^urn:uuid:[a-f0-9-]{36}$/i.test(stored)) return stored;
          if (stored !== null) throw new Error('Invalid host record');
          const created = `urn:uuid:${randomUUID()}`;
          await this.options.store.write(HOST_KEY, created);
          return created;
        })();
        hostIds.set(this.options.store, host);
        void host.catch(() => hostIds.delete(this.options.store));
      }
      this.hostId = await host;
      const raw = await this.options.store.read(this.key);
      if (raw !== null) {
        const record = JSON.parse(raw) as Saved;
        if (record.version !== 1 || !Array.isArray(record.accounts) || record.accounts.length > 100) throw new Error('Invalid stored registration');
        const ids = new Set<string>();
        for (const account of record.accounts) {
          if (!issuedClient(account.clientId) || !textField(account.subject) || account.id !== accountId(account.clientId, account.subject)
            || typeof account.label !== 'string' || account.label.length > 300 || ids.has(account.id)
            || (account.email !== undefined && typeof account.email !== 'string')) throw new Error('Invalid account mapping');
          ids.add(account.id);
          if (account.tokens) {
            const token = account.tokens;
            if ((token.accessToken !== undefined && !textField(token.accessToken)) || !textField(token.idToken) || !textField(token.nonce)
              || !Number.isFinite(token.expiresAt) || !Array.isArray(token.scopes) || !token.scopes.every(s => typeof s === 'string')
              || (token.refreshToken !== undefined && !textField(token.refreshToken))
              || (token.scopes.includes(DIRECT_SCOPE) && !textField(token.accessToken))) throw new Error('Invalid token record');
          }
        }
        if (record.active !== undefined && !ids.has(record.active)) throw new Error('Invalid active account');
        this.saved = record;
      }
      this.ready = true;
      this.notify();
    } catch {
      this.error = 'Protected ChatGPT credentials are unavailable. Unlock or enable the system keychain and restart Coopanion.';
      this.notify();
      throw new AuthError(this.error, 'storage');
    }
  }

  /** Serialize disk commits; stale work cannot commit after cancel, restart, account switch, or logout. */
  private persist(generation: number, update: () => Saved): Promise<void> {
    const next = this.persistQueue.then(async () => {
      this.check(generation);
      const record = update();
      try { await this.options.store.write(this.key, JSON.stringify(record)); }
      catch {
        // An IPC timeout is an uncertain write, not proof of failure. The broker serializes this
        // compensating write after the first one, including across a child-process restart.
        await this.options.store.write(this.key, JSON.stringify(this.saved)).catch(() => {});
        throw new AuthError('ChatGPT credentials could not be saved securely. Unlock the system keychain and try again.', 'storage');
      }
      if (generation !== this.generation) {
        // Cancellation may happen while an atomic write is already in flight. Restore the latest
        // accepted state before releasing the queue so a restart cannot resurrect that sign-in.
        try { await this.options.store.write(this.key, JSON.stringify(this.saved)); }
        catch { throw new AuthError('Cancelled ChatGPT credentials could not be cleared securely. Restart Coopanion and sign out.', 'storage'); }
        this.check(generation);
      }
      this.saved = record;
    });
    this.persistQueue = next.catch(() => {});
    return next;
  }
  private check(generation: number): void {
    if (generation !== this.generation) throw new AuthError('This sign-in session was cancelled. Start again.', 'cancelled');
  }
  private stopPending(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending?.listener?.close();
    this.pending = undefined;
  }
  private invalidate(): number {
    this.generation++;
    this.stopPending();
    for (const request of this.requests) request.abort();
    this.refreshing = undefined;
    return this.generation;
  }
  cancelLogin(): ChatGPTAuthState {
    if (this.signingOut) return this.state();
    this.invalidate();
    this.error = undefined;
    this.notify();
    return this.state();
  }

  async beginLogin({ accountId: selectedId, newAccount = false, enablePlanUsage = false }: { accountId?: string; newAccount?: boolean; enablePlanUsage?: boolean } = {}): Promise<ChatGPTAuthState> {
    // A requested account switch stops the previous account's in-flight inference immediately,
    // before opening the browser. Cancellation can reuse its credentials, never its old requests.
    this.sessionChanged();
    await this.loaded;
    if (this.signingOut) await this.signingOut;
    const generation = this.invalidate();
    const selected = newAccount ? undefined : selectedId ? this.saved.accounts.find(a => a.id === selectedId) : this.active;
    if (selectedId && !selected && !newAccount) throw new AuthError('Choose a saved ChatGPT account or add a new account.');
    this.error = undefined;
    this.remoteRevocationConfirmed = undefined;
    const transaction: Pending = {
      generation, state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(64).toString('base64url'), clientId: selected?.clientId ?? (newAccount ? undefined : this.retryClientId) ?? 'dynamic_agent_client',
      account: selected, expiresAt: this.now() + (this.options.loginTimeoutMs ?? LOGIN_LIFETIME), consumed: false,
    };
    this.pending = transaction;
    this.notify();
    try {
      const listener = await (this.options.createListener ?? createLoopbackListener)(url => this.callback(transaction, url));
      if (generation !== this.generation) { listener.close(); this.check(generation); }
      const callback = new URL(listener.redirectUri);
      if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port || callback.pathname !== '/auth/callback'
        || callback.username || callback.password || callback.search || callback.hash) { listener.close(); throw new AuthError('The local ChatGPT callback could not be started.'); }
      transaction.listener = listener;
      transaction.redirectUri = listener.redirectUri;
      transaction.timer = setTimeout(() => {
        if (this.pending !== transaction) return;
        this.invalidate();
        this.error = 'ChatGPT sign-in timed out. Try again.';
        this.notify();
      }, this.options.loginTimeoutMs ?? LOGIN_LIFETIME);
      transaction.timer.unref?.();
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({
        client_id: transaction.clientId, ext_agent_host_id: this.hostId,
        response_type: 'code', redirect_uri: listener.redirectUri, scope: SCOPES, resource: RESOURCE,
        state: transaction.state, nonce: transaction.nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url'),
      }).toString();
      if (transaction.clientId === 'dynamic_agent_client') url.searchParams.set('agent_name_hint', 'Coopanion');
      if (selected?.tokens?.idToken) url.searchParams.set('id_token_hint', selected.tokens.idToken);
      if (selected?.email) url.searchParams.set('login_hint', selected.email);
      if (enablePlanUsage) url.searchParams.set('prompt', 'consent');
      await this.options.openExternal(url.href);
      this.check(generation);
      return this.state();
    } catch (error) {
      if (generation === this.generation) { this.stopPending(); this.error = safeMessage(error); this.notify(); }
      throw new AuthError(safeMessage(error));
    }
  }

  private async callback(transaction: Pending, url: URL): Promise<CallbackResult> {
    if (this.pending !== transaction || transaction.consumed || transaction.generation !== this.generation) return { status: 400, message: 'This sign-in attempt is no longer active. Return to Coopanion.' };
    transaction.consumed = true;
    if (transaction.timer) clearTimeout(transaction.timer);
    // Stop accepting more callbacks, but allow this response to finish.
    transaction.listener?.close();
    try {
      const expected = new URL(transaction.redirectUri!);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || transaction.expiresAt <= this.now()
        || url.searchParams.getAll('state').length !== 1 || !same(url.searchParams.get('state') ?? '', transaction.state)) throw new AuthError('ChatGPT sign-in could not be verified. Try again.');
      if (url.searchParams.has('error')) throw new AuthError(url.searchParams.get('error') === 'access_denied' ? 'ChatGPT permission was declined. Continue with ChatGPT to try again.' : 'ChatGPT sign-in was not completed. Try again.');
      const returnedClient = url.searchParams.get('client_id');
      if (url.searchParams.getAll('client_id').length > 1 || (transaction.clientId === 'dynamic_agent_client' && !issuedClient(returnedClient))
        || (transaction.clientId !== 'dynamic_agent_client' && returnedClient !== null && returnedClient !== transaction.clientId)) throw new AuthError('ChatGPT returned an unexpected client registration. Try again.');
      const clientId = transaction.clientId === 'dynamic_agent_client' ? returnedClient! : transaction.clientId;
      const code = url.searchParams.get('code');
      if (!textField(code) || url.searchParams.getAll('code').length !== 1) throw new AuthError('ChatGPT did not return a valid authorization code. Try again.');
      let body: Record<string, unknown>;
      try {
        body = await this.tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId,
          code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri!, resource: RESOURCE }), transaction.generation);
      } catch (error) {
        if (error instanceof AuthError && error.code === 'invalid_grant') this.retryClientId = clientId;
        throw error;
      }
      const identity = await this.validateIdentity(body.id_token, clientId, transaction.nonce, transaction.generation);
      if (transaction.account && identity.sub !== transaction.account.subject) throw new AuthError('ChatGPT returned a different account. Choose the intended saved account and try again.');
      const tokens = this.readTokens(body, transaction.nonce);
      const id = accountId(clientId, identity.sub);
      const email = typeof identity.email === 'string' ? identity.email.slice(0, 254) : undefined;
      const account: Registration = { id, clientId, subject: identity.sub, email, label: `${email ?? 'ChatGPT account'} · ${id.slice(0, 6)}`, tokens };
      await this.persist(transaction.generation, () => ({ version: 1, active: id, accounts: [...this.saved.accounts.filter(a => a.id !== id), account] }));
      this.check(transaction.generation);
      this.retryClientId = undefined;
      this.stopPending();
      this.sessionChanged();
      this.error = tokens.scopes.includes(DIRECT_SCOPE) ? undefined : 'Signed in, but ChatGPT plan usage is not enabled. Enable plan usage or choose an API-key provider.';
      this.notify();
      return { status: 200, message: tokens.scopes.includes(DIRECT_SCOPE) ? 'You are connected. You can close this tab and return to Coopanion.' : 'You are signed in, but ChatGPT plan usage is not enabled. Return to Coopanion.' };
    } catch (error) {
      if (transaction.generation === this.generation) { this.stopPending(); this.error = safeMessage(error); this.notify(); }
      return { status: 400, message: 'Sign-in could not be completed. Return to Coopanion and try again.' };
    }
  }

  private async request(url: string, init: RequestInit, generation?: number): Promise<Response> {
    if (generation !== undefined) this.check(generation);
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 15_000);
    timer.unref?.();
    try {
      const result = await this.http(url, { ...init, redirect: 'error', signal: controller.signal });
      if (generation !== undefined) this.check(generation);
      // Buffer before clearing the deadline so a stalled response body cannot hang token refresh.
      const content = await result.text();
      if (content.length > 1024 * 1024) throw new AuthError('ChatGPT returned an invalid response. Try again.');
      if (generation !== undefined) this.check(generation);
      return new Response(content || null, { status: result.status, statusText: result.statusText, headers: result.headers });
    } catch (error) {
      if (generation !== undefined) this.check(generation);
      if (error instanceof AuthError) throw error;
      throw new AuthError('ChatGPT could not be reached. Check your connection and try again.', 'network');
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  private async tokenRequest(body: URLSearchParams, generation: number): Promise<Record<string, unknown>> {
    const response = await this.request(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body }, generation);
    let data: Record<string, unknown>;
    try { data = await response.json() as Record<string, unknown>; }
    catch { throw new AuthError('ChatGPT returned an invalid token response. Try again.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AuthError('ChatGPT returned an invalid token response. Try again.');
    if (response.status !== 200) {
      const rawCode = typeof data.error === 'string' ? data.error : (data.error as { code?: unknown } | null)?.code;
      const code = typeof rawCode === 'string' && (TERMINAL_REFRESH_ERRORS.has(rawCode) || rawCode === 'invalid_client') ? rawCode : 'token_error';
      throw new AuthError(code === 'invalid_client' ? 'The ChatGPT client registration was rejected. Check the integration configuration.'
        : TERMINAL_REFRESH_ERRORS.has(code) ? 'Your ChatGPT session has expired or was revoked. Continue with ChatGPT to sign in again.'
        : 'ChatGPT could not renew or complete sign-in. Try again later.', code);
    }
    return data;
  }
  private readTokens(body: Record<string, unknown>, nonce: string, previous?: Tokens): Tokens {
    const scopes = typeof body.scope === 'string' ? [...new Set(body.scope.split(/\s+/).filter(Boolean))] : [];
    const direct = scopes.includes(DIRECT_SCOPE);
    if ((body.scope !== undefined && (typeof body.scope !== 'string' || body.scope.length > 8192))
      || (body.access_token !== undefined && !textField(body.access_token))
      || (body.refresh_token !== undefined && !textField(body.refresh_token))
      || (body.id_token !== undefined && !textField(body.id_token))
      || (!previous && !textField(body.id_token))
      || (body.token_type !== undefined && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'))
      || (body.expires_in !== undefined && (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 86_400))) {
      throw new AuthError('ChatGPT returned incomplete credentials. Sign in again.');
    }
    if (direct && (!textField(body.access_token) || typeof body.token_type !== 'string' || typeof body.expires_in !== 'number')) {
      throw new AuthError('ChatGPT returned incomplete plan-usage credentials. Sign in again.');
    }
    if ((scopes.includes('offline_access') || (direct && previous?.refreshToken)) && !textField(body.refresh_token)) {
      throw new AuthError('ChatGPT did not return renewable credentials. Sign in again.');
    }
    const earliest = typeof body.earliest_refresh_at === 'number' && Number.isFinite(body.earliest_refresh_at) ? body.earliest_refresh_at * 1000 : undefined;
    return {
      accessToken: body.access_token as string | undefined, refreshToken: body.refresh_token as string | undefined,
      idToken: typeof body.id_token === 'string' ? body.id_token : previous!.idToken, nonce,
      expiresAt: typeof body.expires_in === 'number' ? this.now() + body.expires_in * 1000 : 0, scopes,
      ...(earliest !== undefined ? { earliestRefreshAt: earliest } : {}),
    };
  }

  private async discover(generation?: number): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const response = await this.request(DISCOVERY, { headers: { accept: 'application/json' } }, generation);
    if (!response.ok) throw new AuthError('ChatGPT identity verification is temporarily unavailable. Try again.');
    const result = await response.json() as Discovery & { authorization_endpoint?: string; token_endpoint?: string };
    const trusted = (value: unknown): value is string => {
      try { const url = new URL(String(value)); return url.origin === ISSUER && !url.username && !url.password && !url.hash && !url.search; } catch { return false; }
    };
    if (result.issuer !== ISSUER || !trusted(result.jwks_uri) || (result.revocation_endpoint !== undefined && !trusted(result.revocation_endpoint))
      || (result.authorization_endpoint !== undefined && result.authorization_endpoint !== AUTHORIZE)
      || (result.token_endpoint !== undefined && result.token_endpoint !== TOKEN)) throw new AuthError('ChatGPT identity configuration could not be verified.');
    this.discovery = result;
    return result;
  }
  private async validateIdentity(raw: unknown, clientId: string, nonce: string, generation: number, refresh = false): Promise<Identity> {
    try {
      if (!textField(raw)) throw new Error('Missing identity token');
      const parts = raw.split('.');
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error('Invalid JWT');
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg?: string; kid?: string; crit?: unknown };
      if (!['RS256', 'ES256'].includes(header.alg ?? '') || typeof header.kid !== 'string' || !header.kid || header.crit !== undefined) throw new Error('Unsupported JWT');
      const discovery = await this.discover(generation);
      const getKeys = async () => {
        const response = await this.request(discovery.jwks_uri, { headers: { accept: 'application/json' } }, generation);
        if (!response.ok) throw new Error('JWKS unavailable');
        const data = await response.json() as { keys?: (JsonWebKey & { kid?: string; alg?: string; use?: string; key_ops?: string[] })[] };
        if (!Array.isArray(data.keys) || data.keys.length > 100) throw new Error('Invalid JWKS');
        this.jwks = { keys: data.keys, expiresAt: this.now() + 60 * 60_000 };
      };
      let fetched = false;
      if (!this.jwks || this.jwks.expiresAt <= this.now()) { await getKeys(); fetched = true; }
      const matches = () => this.jwks!.keys.filter(key => key.kid === header.kid && (!key.alg || key.alg === header.alg)
        && (!key.use || key.use === 'sig') && (!key.key_ops || key.key_ops.includes('verify'))
        && (header.alg === 'RS256' ? key.kty === 'RSA' : key.kty === 'EC' && key.crv === 'P-256'));
      if (!matches().length && !fetched) await getKeys();
      const keys = matches();
      if (keys.length !== 1) throw new Error('Unknown JWT key');
      const key = createPublicKey({ key: keys[0], format: 'jwk' });
      if (header.alg === 'RS256' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('Weak JWT key');
      if (!verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid JWT signature');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
      const now = this.now() / 1000;
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (payload.iss !== discovery.issuer || !audiences.includes(clientId) || (audiences.length > 1 && payload.azp !== clientId)
        || (payload.azp !== undefined && payload.azp !== clientId)
        || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now - 5
        || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now + 5
        || (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > now + 5))
        || !textField(payload.sub) || (!refresh && payload.nonce !== nonce) || (refresh && payload.nonce !== undefined && payload.nonce !== nonce)) throw new Error('Invalid JWT claims');
      this.check(generation);
      return { sub: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}), ...(typeof payload.nonce === 'string' ? { nonce: payload.nonce } : {}) };
    } catch (error) {
      this.check(generation);
      if (error instanceof AuthError && error.code === 'network') throw error;
      throw new AuthError('ChatGPT identity could not be verified. Sign in again.');
    }
  }

  async getAccessToken(): Promise<string> {
    await this.loaded;
    if (this.signingOut) throw new AuthError('ChatGPT is signing out.');
    const tokens = this.active?.tokens;
    if (!tokens) throw new AuthError('Continue with ChatGPT to sign in.');
    if (!tokens.scopes.includes(DIRECT_SCOPE) || !tokens.accessToken) throw new AuthError('ChatGPT plan usage is not enabled for this account.');
    if (tokens.expiresAt - this.now() > 60_000 || (tokens.expiresAt > this.now() && (tokens.earliestRefreshAt ?? 0) > this.now())) return tokens.accessToken;
    return this.refresh();
  }
  async refresh(): Promise<string> {
    await this.loaded;
    if (this.signingOut) throw new AuthError('ChatGPT is signing out.');
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    const account = this.active;
    const previous = account?.tokens;
    if (!account || !previous?.refreshToken) throw new AuthError('Your ChatGPT session needs a new sign-in.');
    if ((previous.earliestRefreshAt ?? 0) > this.now()) throw new AuthError('ChatGPT credentials cannot be refreshed yet. Try again later.');
    const work = (async () => {
      let rotated = false;
      try {
        const body = await this.tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: previous.refreshToken!, resource: RESOURCE }), generation);
        rotated = true;
        if (body.id_token !== undefined) {
          const identity = await this.validateIdentity(body.id_token, account.clientId, previous.nonce, generation, true);
          if (identity.sub !== account.subject) throw new AuthError('ChatGPT returned a different account during renewal. Sign in again.');
        }
        const tokens = this.readTokens(body, previous.nonce, previous);
        await this.persist(generation, () => ({ ...this.saved, accounts: this.saved.accounts.map(a => a.id === account.id ? { ...a, tokens } : a) }));
        this.check(generation);
        this.error = tokens.scopes.includes(DIRECT_SCOPE) ? undefined : 'ChatGPT plan usage is no longer enabled. Enable it or choose an API-key provider.';
        this.notify();
        rotated = false;
        if (!tokens.scopes.includes(DIRECT_SCOPE)) throw new AuthError(this.error!);
        return tokens.accessToken!;
      } catch (error) {
        if (generation === this.generation) {
          if (rotated || (error instanceof AuthError && TERMINAL_REFRESH_ERRORS.has(error.code))) {
            this.sessionChanged();
            // Once rotation succeeds, never replay the previous refresh token even if validation
            // or durable storage fails. Keep only the issued client and verified identity.
            this.saved = { ...this.saved, accounts: this.saved.accounts.map(a => a.id === account.id ? { ...a, tokens: undefined } : a) };
            await this.persist(generation, () => this.saved);
          }
          this.error = safeMessage(error);
          this.notify();
        }
        throw new AuthError(safeMessage(error));
      }
    })();
    this.refreshing = work;
    void work.finally(() => { if (this.refreshing === work) this.refreshing = undefined; }).catch(() => {});
    return work;
  }

  /** Drain secure commits before the child credential IPC is disposed on app shutdown. */
  async shutdown(): Promise<void> {
    if (this.signingOut) await this.signingOut.catch(() => {});
    this.invalidate();
    this.sessionChanged();
    await this.persistQueue;
  }

  async logout(): Promise<ChatGPTAuthState> {
    if (this.signingOut) return this.signingOut;
    const generation = this.invalidate();
    this.sessionChanged();
    this.error = undefined;
    const work = (async () => {
      await this.loaded;
      const account = this.active;
      const refreshToken = account?.tokens?.refreshToken;
      // Hide tokens immediately; callers are also blocked by signingOut until cleanup commits.
      this.saved = { ...this.saved, accounts: this.saved.accounts.map(a => a.id === account?.id ? { ...a, tokens: undefined } : a) };
      this.notify();
      let revoked = !refreshToken;
      if (refreshToken && account) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const configuration = await this.discover(generation);
            if (!configuration.revocation_endpoint) break;
            const response = await this.request(configuration.revocation_endpoint, { method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }) }, generation);
            if (response.status === 200) { revoked = true; break; }
            if (response.status < 500) break;
          } catch { /* bounded retry before dropping the token locally */ }
          if (attempt === 0) await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(250);
        }
      }
      await this.persist(generation, () => this.saved);
      this.remoteRevocationConfirmed = revoked;
      this.error = revoked ? undefined : 'Signed out locally. Remote revocation was not confirmed; disconnect Coopanion in ChatGPT Settings to end access.';
      this.notify();
      return this.state();
    })();
    this.signingOut = work;
    void work.finally(() => { if (this.signingOut === work) this.signingOut = undefined; }).catch(() => {});
    return work;
  }
}
