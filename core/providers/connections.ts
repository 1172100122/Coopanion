/** The app's account-aware provider module; Cortico continues to own the tool loop. */
import { createHash } from 'node:crypto';
import { BaseProvider, type ProviderInstance, type ProviderModule, type ListedModel } from 'cortico/providers/base.ts';
import type { LLMProviderEntry, ConfigGroup } from 'cortico/core/types.ts';
import { GenerationError, type GenerateOptions, type Generation } from 'cortico/core/generation.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import type { ProviderConsoleHost } from 'cortico/providers/console/types.ts';
import { connectionBlocks } from 'cortico/providers/console/config.ts';
import { isContextOverflow } from 'cortico/providers/transport/errors.ts';
import { GenericChatProvider, AuthenticatedResponsesProvider, AnthropicMessagesProvider, type TransportAuth } from './protocols.ts';
import { CapabilityCatalog, type ProviderModel } from './catalog.ts';
import { CONNECTION_KIND, CHATGPT_BASE_URL, XAI_BASE_URL, SERVICES, PROTOCOLS, GO_UNAVAILABLE, connectionOptions, validateConnection } from './options.ts';

export interface AccountState {
  ready: boolean;
  authenticated: boolean;
  planUsageEnabled: boolean;
  pending: boolean;
  status: 'signed-out' | 'authorizing' | 'connected' | 'expired' | 'error';
  error?: string;
  account?: { id: string; label?: string; email?: string } | null;
  accounts?: Array<{ id: string; label: string; email?: string }>;
}
export interface ConnectionAuth {
  state(): AccountState;
  whenReady(): Promise<void>;
  beginLogin(options?: { accountId?: string; newAccount?: boolean; enablePlanUsage?: boolean }): Promise<unknown>;
  cancelLogin(): unknown;
  logout(): Promise<unknown>;
  getAccessToken(): Promise<string>;
  refresh(): Promise<string>;
  shutdown(): Promise<void>;
  readonly sessionSignal: AbortSignal;
  readonly sessionVersion: number;
}
export interface ConnectionsOptions {
  auth(name: string): ConnectionAuth;
  fetch?: typeof fetch;
  onBlocked?(name: string): void;
}
interface ConnectionControl {
  state(): Record<string, unknown>;
  login(options?: { accountId?: string; newAccount?: boolean; enablePlanUsage?: boolean }): Promise<unknown>;
  cancel(): unknown;
  logout(): Promise<unknown>;
}
interface CatalogState { account: string; models: ProviderModel[]; }
const usableAccount = (state: AccountState): boolean => state.ready && state.authenticated && state.planUsageEnabled && !state.pending && state.status === 'connected';

function config(name: string, entry: LLMProviderEntry, language: 'zh' | 'en'): ConfigGroup[] {
  const zh = language === 'zh';
  const prefix = `providers.${name}.options.`;
  return [{ id: `llm.${CONNECTION_KIND}.${name}.transport`, owner: `provider:${CONNECTION_KIND}`, schema: {
    type: 'object', title: zh ? '连接方式' : 'Connection', properties: {
      [`${prefix}service`]: { type: 'string', enum: [...SERVICES], title: zh ? '服务' : 'Service' },
      [`${prefix}protocol`]: { type: 'string', enum: [...PROTOCOLS], title: zh ? 'API 协议' : 'API protocol' },
      ...(connectionOptions(entry).service === 'custom' ? {
        [`${prefix}inputImages`]: { type: 'boolean', title: zh ? '模型支持图像输入' : 'Model supports image input', description: zh ? '仅在该模型的服务文档确认支持时开启。' : 'Enable only when the model documentation confirms support.' },
      } : {}),
    },
  } }];
}

/** Errors returned by a subscription endpoint do not carry response bodies into logs or the UI. */
const SUBSCRIPTION_CODES: Record<string, string> = {
  subscription_sharing_user_not_eligible: 'This ChatGPT account is not eligible for subscription sharing.',
  subscription_sharing_usage_limit_exceeded: 'ChatGPT plan usage is limited. Check your usage page before resuming.',
  subscription_sharing_usage_unavailable: 'ChatGPT plan usage is temporarily unavailable. Try again later.',
  subscription_sharing_unsupported_capability: 'This request includes a capability the ChatGPT plan connection does not support.',
  subscription_sharing_route_not_supported: 'The ChatGPT plan connection does not support this endpoint or method.',
  subscription_sharing_invalid_user: 'The ChatGPT account could not be validated. Check your sign-in.',
  chatpass_v2_scope_not_authorized: 'ChatGPT plan usage has not been authorized for this connection.',
  chatpass_v2_invalid_authorization_context: 'The ChatGPT application authorization context is invalid.',
  subscription_sharing_user_unavailable: 'The ChatGPT account is temporarily unavailable. Try again later.',
};
function errorCode(error: GenerationError): string | undefined {
  try {
    const value = JSON.parse(error.body) as { error?: { code?: unknown }; code?: unknown };
    const code = value.error?.code ?? value.code;
    if (typeof code === 'string' && code in SUBSCRIPTION_CODES) return code;
  } catch { /* Some failures carry only the final stream item. */ }
  const code = error.partial?.error?.code;
  return typeof code === 'string' && code in SUBSCRIPTION_CODES ? code : undefined;
}
function subscriptionError(error: unknown): Error {
  if (!(error instanceof GenerationError)) return new Error('ChatGPT request could not finish. Check the connection or sign in again.');
  const code = errorCode(error);
  const message = code ? SUBSCRIPTION_CODES[code] : error.status === 429 ? 'ChatGPT plan usage is limited. Check your remaining usage and retry later. No API-key fallback was used.'
    : error.status === 401 || error.status === 403 ? 'ChatGPT authorization or model access needs attention. Sign in again or choose an available model.'
      : error.attempts.at(-1)?.outcome === 'aborted' ? 'ChatGPT request was canceled.'
        : 'ChatGPT inference did not complete. Check the connection and selected model.';
  let param: string | undefined;
  try { const value = JSON.parse(error.body)?.error?.param; if (typeof value === 'string' && /^[A-Za-z0-9_.\[\]-]{1,100}$/.test(value)) param = value; } catch { /* No structured parameter. */ }
  const requestId = error.attempts.at(-1)?.requestId;
  const details = [code, param && `parameter: ${param}`, requestId && /^[A-Za-z0-9_-]{1,150}$/.test(requestId) ? `request: ${requestId}` : undefined].filter(Boolean).join('; ');
  const partial = error.partial ? { ...error.partial, error: error.partial.error ? { code: code ?? 'inference_failed', message } : null } : null;
  return new GenerationError(`${message}${details ? ` (${details})` : ''}`, error.attempts, partial, error.origin, error.status, code ? JSON.stringify({ error: { code, param, message } }) : '');
}

export function createConnections(options: ConnectionsOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const accounts = new Map<string, ConnectionAuth>();
  const catalogs = new Map<string, CatalogState>();
  const blocked = new Map<string, string>();
  const accountFor = (name: string): ConnectionAuth => {
    let account = accounts.get(name);
    if (!account) { account = options.auth(name); accounts.set(name, account); }
    return account;
  };
  const accountKey = (account: ConnectionAuth): string => {
    const state = account.state();
    return `${state.account?.id ?? ''}:${account.sessionVersion}`;
  };
  const state = (name: string, entry: LLMProviderEntry): Record<string, unknown> => {
    if (connectionOptions(entry).service !== 'chatgpt') return { status: 'connected', entry };
    const account = accountFor(name);
    const current = account.state();
    const cache = catalogs.get(name);
    return {
      status: current.status, ready: usableAccount(current) && !blocked.has(name),
      authenticated: current.authenticated, planUsageEnabled: current.planUsageEnabled,
      accounts: current.accounts ?? [],
      message: current.error ?? blocked.get(name), account: current.account?.label ?? current.account?.email ?? current.account?.id,
      ...(cache?.account === accountKey(account) ? { models: cache.models } : current.status === 'connected' ? {} : { models: [] }), entry,
    };
  };
  const consoleContribution = (host: ProviderConsoleHost) => {
    const blocks = connectionBlocks(host.language);
    return {
      panels: [blocks.endpoint, blocks.model, { id: 'accounts', title: host.language === 'zh' ? '订阅与协议' : 'Subscription and protocol', description: host.language === 'zh' ? '登录、取消与退出请在「开始」页操作。订阅额度由上游管理。' : 'Sign in, cancel, and sign out on the Start page. The provider manages subscription limits.', builtin: 'connection-protocol', defaultOpen: true }, blocks.pricing],
      invoke: async (panel: string, method: string, args: unknown[]) => {
        if (panel !== 'accounts') throw new Error('Unknown connection panel.');
        const input = args[0] as { name?: unknown; newAccount?: unknown; accountId?: unknown; enablePlanUsage?: unknown } | undefined;
        if (!input || typeof input.name !== 'string') throw new Error('A saved connection is required.');
        const found = host.entries().find(value => value.name === input.name);
        if (!found) throw new Error('Connection does not exist.');
        validateConnection(found.entry);
        if (host.editing && ['login', 'cancel', 'logout'].includes(method)) throw new Error('Save the connection before changing its account.');
        const instance = host.instance(found.name);
        const control = instance.control as ConnectionControl;
        if (method === 'state') return control.state();
        if (method === 'models') return instance.listModels!();
        if (connectionOptions(found.entry).service !== 'chatgpt') throw new Error('This connection uses an API key, not subscription sign-in.');
        if (method === 'login') {
          if (input.accountId !== undefined && (typeof input.accountId !== 'string' || !/^[a-f0-9]{24}$/.test(input.accountId))) throw new Error('Invalid saved account selection.');
          if (input.newAccount !== undefined && typeof input.newAccount !== 'boolean' || input.enablePlanUsage !== undefined && typeof input.enablePlanUsage !== 'boolean') throw new Error('Invalid sign-in option.');
          await control.login({ accountId: input.accountId as string | undefined, newAccount: input.newAccount === true, enablePlanUsage: input.enablePlanUsage === true });
          return control.state();
        }
        if (method === 'cancel') { control.cancel(); return control.state(); }
        if (method === 'logout') { await control.logout(); return control.state(); }
        throw new Error('Unknown account action.');
      },
    };
  };
  const module: ProviderModule = {
    id: CONNECTION_KIND,
    title: 'Subscription and API connections',
    description: 'ChatGPT plan sign-in, xAI API keys, and custom Responses, Chat Completions or Anthropic Messages connections. OpenCode Go requires a separate coding-task mode.',
    localize: language => ({ description: language === 'zh' ? 'ChatGPT 订阅登录、xAI API Key 和三种协议的自定义接口。OpenCode Go 仅供编码任务，不能用于持续陪伴。' : 'ChatGPT plan sign-in, xAI API keys, and custom API protocols. OpenCode Go cannot power the continuous companion.' }),
    defaultBaseUrl: CHATGPT_BASE_URL,
    baseUrlSuggestions: [CHATGPT_BASE_URL, XAI_BASE_URL],
    reasoningTiers: [], effortSuggestions: ['none', 'low', 'medium', 'high', 'xhigh'], serviceTiers: [],
    validateEntry: validateConnection,
    config,
    console: consoleContribution,
    contextOverflow: isContextOverflow,
    availability: (name, entry, language) => {
      const service = connectionOptions(entry).service;
      if (service === 'opencode-go') return { ready: false, reason: GO_UNAVAILABLE };
      if (blocked.has(name)) return { ready: false, reason: blocked.get(name) };
      if (entry.spec?.model === 'pending-selection') return { ready: false, reason: language === 'zh' ? '请登录并选择模型。' : 'Sign in and choose a model.' };
      if (service === 'chatgpt') {
        const auth = accountFor(name).state();
        return { ready: usableAccount(auth), reason: auth.error ?? (language === 'zh' ? '请在「开始」页登录 ChatGPT。' : 'Sign in with ChatGPT on the Start page.') };
      }
      return { ready: true };
    },
    accepts: (entry, spec, mime) => {
      if (entry.multimodal !== true || !mime.startsWith('image/')) return false;
      const option = connectionOptions(entry);
      if (option.service === 'custom') return option.inputImages === true;
      // The instance checks its own account's current catalog before rendering image bytes.
      return option.service !== 'opencode-go';
    },
    create(name, entry, host): ProviderInstance {
      validateConnection(entry);
      const settings = connectionOptions(entry);
      const subscription = settings.service === 'chatgpt';
      const account = subscription ? accountFor(name) : null;
      const key = entry.secret ? host.secret(entry.secret) : '';
      const auth: TransportAuth = {
        headers: async (): Promise<Record<string, string>> => account ? { Authorization: `Bearer ${await account.getAccessToken()}` }
          : settings.protocol === 'anthropic-messages' ? { 'x-api-key': key } : { Authorization: `Bearer ${key}` },
        refresh: async () => { if (!account) return false; await account.refresh(); return true; },
      };
      const catalog = new CapabilityCatalog({ baseUrl: entry.baseUrl, auth, format: subscription ? 'chatgpt' : 'api', fetchImpl,
        headers: settings.protocol === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {},
      });
      const listModels = async (): Promise<ListedModel[]> => {
        if (settings.service === 'opencode-go') throw new Error(GO_UNAVAILABLE);
        if (account) await account.whenReady();
        const signal = account ? AbortSignal.any([account.sessionSignal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
        const version = account ? accountKey(account) : '';
        catalogs.delete(name);
        const models = await catalog.list(signal);
        if (signal.aborted || (account && version !== accountKey(account))) throw new Error('Account changed while loading the model catalog.');
        catalogs.set(name, { account: version, models });
        return models;
      };
      const media = { enabled: () => {
        const current = host.currentEntry?.() ?? entry;
        if (!current.multimodal) return false;
        if (settings.service === 'custom') return connectionOptions(current).inputImages === true;
        const cache = catalogs.get(name);
        return (!account || cache?.account === accountKey(account)) && cache?.models.some(model => model.id === current.spec?.model && model.inputImages === true) === true;
      }, read: host.readBlob };
      const common = { baseUrl: entry.baseUrl, auth, media, keepThinking: host.keepThinking, log: host.log };
      const native = settings.protocol === 'chat-completions' ? new GenericChatProvider(common)
        : settings.protocol === 'anthropic-messages' ? new AnthropicMessagesProvider(common)
          : new AuthenticatedResponsesProvider({ ...common, forceStream: subscription, chatgpt: subscription });
      class ConnectionClient extends BaseProvider {
        async respond(request: Request, opts: GenerateOptions = {}): Promise<Generation> {
          if (settings.service === 'opencode-go') throw new Error(GO_UNAVAILABLE);
          if (request.model === 'pending-selection') throw new Error('Choose a model before sending a request.');
          if (!opts.diagnostic && blocked.has(name)) throw new Error(blocked.get(name));
          const enforceCapabilities = () => {
            const capability = catalogs.get(name)?.models.find(model => model.id === request.model);
            if (capability?.tools === false && request.tools?.length) throw new Error('The selected model does not support the companion function tools. Choose a tool-capable model.');
            if (capability?.reasoning === false && request.reasoning?.effort && request.reasoning.effort !== 'none') throw new Error('The selected model does not support reasoning controls.');
          };
          if (!account) {
            if (settings.service === 'xai' && (host.currentEntry?.() ?? entry).multimodal && !catalogs.has(name)) await listModels();
            enforceCapabilities();
            return native.respond(request, opts);
          }
          await account.whenReady();
          const session = account.sessionSignal;
          const version = accountKey(account);
          if (!catalogs.has(name) || catalogs.get(name)!.account !== version) await listModels();
          if (!catalogs.get(name)!.models.some(model => model.id === request.model)) throw new Error('Choose a model available to this ChatGPT account.');
          enforceCapabilities();
          const signal = opts.signal ? AbortSignal.any([opts.signal, session]) : session;
          if (signal.aborted || version !== accountKey(account)) throw new Error('ChatGPT account changed; start a new request.');
          try {
            const result = await native.respond(request, { ...opts, signal });
            if (result.response.status !== 'completed') throw new GenerationError('ChatGPT inference did not complete.', result.attempts, result.response, result.origin);
            blocked.delete(name);
            return result;
          }
          catch (error) {
            const safe = subscriptionError(error);
            const code = error instanceof GenerationError ? errorCode(error) : undefined;
            if (error instanceof GenerationError && (error.status === 401 || error.status === 403 || error.status === 429 || (code && !code.endsWith('_unavailable')))) {
              blocked.set(name, safe.message);
              options.onBlocked?.(name);
            }
            throw safe;
          }
        }
      }
      return {
        client: new ConnectionClient(), listModels,
        compatibilityKey: () => [settings.service, settings.protocol, name, account?.state().account?.id ?? 'api-key'],
        contextWindow: model => {
          const cache = catalogs.get(name);
          return (!account || cache?.account === accountKey(account)) ? cache?.models.find(value => value.id === model)?.contextWindow : undefined;
        },
        control: {
          state: () => account ? state(name, host.currentEntry?.() ?? entry) : { status: key ? 'connected' : 'signed-out', entry: host.currentEntry?.() ?? entry },
          login: async (loginOptions) => { catalogs.delete(name); blocked.delete(name); return account!.beginLogin(loginOptions); },
          cancel: () => account!.cancelLogin(),
          logout: async () => { catalogs.delete(name); blocked.delete(name); return account!.logout(); },
        } satisfies ConnectionControl,
      };
    },
  };
  return {
    module,
    async initialize(entries: Record<string, LLMProviderEntry>): Promise<void> {
      await Promise.all(Object.entries(entries).filter(([, entry]) => entry.kind === CONNECTION_KIND && connectionOptions(entry)?.service === 'chatgpt').map(async ([name]) => { await accountFor(name).whenReady().catch(() => {}); }));
    },
    async stop(): Promise<void> { await Promise.all([...accounts.values()].map(account => account.shutdown())); },
  };
}

export function credentialNamespace(name: string): string {
  return `coopanion-chatgpt-${createHash('sha256').update(name).digest('hex')}`;
}
