/** Connection transport choices; account credentials never belong in this configuration. */
import type { LLMProviderEntry } from 'cortico/core/types.ts';

export const CONNECTION_KIND = 'connections';
export const CHATGPT_BASE_URL = 'https://api.openai.com/v1';
export const XAI_BASE_URL = 'https://api.x.ai/v1';
export const GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const SERVICES = ['chatgpt', 'xai', 'opencode-go', 'custom'] as const;
export const PROTOCOLS = ['responses', 'chat-completions', 'anthropic-messages'] as const;
export type ConnectionService = typeof SERVICES[number];
export type ConnectionProtocol = typeof PROTOCOLS[number];
export interface ConnectionOptions {
  service: ConnectionService;
  protocol: ConnectionProtocol;
  inputImages?: boolean;
  codingOnly?: boolean;
}

export function connectionOptions(entry: LLMProviderEntry): ConnectionOptions {
  return entry.options as unknown as ConnectionOptions;
}

export function validateConnection(entry: LLMProviderEntry): void {
  const options = entry.options;
  if (!options || !SERVICES.includes(options.service as ConnectionService)) throw new Error('Choose a supported connection service.');
  if (!PROTOCOLS.includes(options.protocol as ConnectionProtocol)) throw new Error('Choose a supported API protocol.');
  for (const key of Object.keys(options)) {
    if (!['service', 'protocol', 'inputImages', 'codingOnly'].includes(key)) throw new Error(`Unsupported connection option: ${key}`);
  }
  for (const key of ['inputImages', 'codingOnly']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
  }
  let url: URL;
  try { url = new URL(entry.baseUrl); } catch { throw new Error('A valid API base URL is required.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('API base URLs cannot contain credentials, a query, or a fragment.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use HTTPS for remote APIs; HTTP is only allowed on loopback.');
  const base = entry.baseUrl.replace(/\/+$/, '');
  if (options.service === 'chatgpt') {
    if (base !== CHATGPT_BASE_URL || options.protocol !== 'responses') throw new Error('ChatGPT subscriptions use the official OpenAI Responses endpoint.');
    if (entry.secret) throw new Error('Sign in with ChatGPT; do not put a subscription token in the API-key field.');
    if (options.inputImages !== undefined) throw new Error('ChatGPT image support is determined by the signed-in account model catalog.');
  }
  if (options.service === 'xai' && base !== XAI_BASE_URL) throw new Error('The xAI connection uses https://api.x.ai/v1.');
  if (options.service === 'opencode-go' && base !== GO_BASE_URL) throw new Error('OpenCode Go requires its dedicated subscription endpoint.');
  if (options.service === 'custom' && url.hostname === 'opencode.ai' && url.pathname.startsWith('/zen/go')) {
    throw new Error('OpenCode Go is coding-only and cannot be used by the continuous companion.');
  }
  if (options.service !== 'chatgpt' && !entry.secret) throw new Error('Configure the API-key variable for this connection.');
}

export const GO_UNAVAILABLE = 'OpenCode Go is restricted to coding tasks. The continuous companion has no isolated coding-task mode; this connection cannot be activated.';
