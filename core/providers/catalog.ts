import type { ListedModel } from 'cortico/providers/base.ts';
import type { TransportAuth } from './protocols.ts';

export type ProtocolKind = 'responses' | 'chat-completions' | 'anthropic-messages';
/** Undefined means the service did not advertise the capability, never an inferred yes. */
export interface ProviderModel extends ListedModel {
  tools?: boolean;
  reasoning?: boolean;
  protocol?: ProtocolKind;
}
type Json = Record<string, unknown>;
function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function positive(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function bool(...values: unknown[]): boolean | undefined { return values.find(value => typeof value === 'boolean') as boolean | undefined; }
function protocol(value: unknown): ProtocolKind | undefined {
  if (value === 'responses' || value === 'openai-responses') return 'responses';
  if (value === 'chat-completions' || value === 'chat_completions' || value === 'openai-compatible') return 'chat-completions';
  if (value === 'anthropic-messages' || value === 'messages' || value === 'anthropic') return 'anthropic-messages';
  return undefined;
}
function capabilities(row: Json): Omit<ProviderModel, 'id' | 'displayName'> {
  const limits = object(row.limit), architecture = object(row.architecture), caps = object(row.capabilities);
  const modalities = row.input_modalities ?? architecture.input_modalities ?? object(row.modalities).input;
  const parameters = row.supported_parameters;
  const contextWindow = positive(row.context_window) ?? positive(row.context_length) ?? positive(limits.context);
  const maxOutputTokens = positive(row.max_output_tokens) ?? positive(row.max_completion_tokens) ?? positive(object(row.top_provider).max_completion_tokens) ?? positive(limits.output);
  const inputImages = bool(row.input_images, row.supports_images, caps.inputImages, caps.vision, Array.isArray(modalities) ? modalities.includes('image') : undefined);
  const tools = bool(row.tool_call, row.supports_tools, caps.tools, Array.isArray(parameters) ? parameters.includes('tools') : undefined);
  const reasoning = bool(row.reasoning, row.supports_reasoning, caps.reasoning, Array.isArray(parameters) ? parameters.includes('reasoning') || parameters.includes('reasoning_effort') : undefined);
  const wireProtocol = protocol(row.protocol) ?? protocol(row.api);
  return { ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputImages !== undefined ? { inputImages } : {}), ...(tools !== undefined ? { tools } : {}), ...(reasoning !== undefined ? { reasoning } : {}),
    ...(wireProtocol ? { protocol: wireProtocol } : {}) };
}
function parseRows(raw: unknown, format: 'api' | 'chatgpt'): ProviderModel[] {
  const field = format === 'chatgpt' ? 'models' : 'data';
  const rows = object(raw)[field];
  if (!Array.isArray(rows)) throw new Error(`Model catalog returned no ${field} array`);
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const value of rows) {
    const row = object(value), id = row[format === 'chatgpt' ? 'slug' : 'id'];
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue;
    if (format === 'chatgpt' && row.visibility !== 'list') continue;
    if (row.visibility === 'hide' || row.visibility === 'hidden' || row.visibility === 'disabled' || row.visibility === false) continue;
    const label = row.display_name ?? row.name;
    models.push({ id, ...(typeof label === 'string' && label.trim() ? { displayName: label } : {}), ...capabilities(row) });
    seen.add(id);
  }
  return models;
}
/** API-key catalogs commonly use data[].id; preserve upstream order and explicit capability values. */
export function parseApiModels(raw: unknown): ProviderModel[] { return parseRows(raw, 'api'); }
/** SIWC uses models[].slug, including account visibility/order; it is not the API-key catalog. */
export function parseChatGPTModels(raw: unknown): ProviderModel[] { return parseRows(raw, 'chatgpt'); }

export interface CapabilityCatalogOptions {
  baseUrl: string;
  endpointPath?: string;
  format?: 'api' | 'chatgpt';
  auth?: TransportAuth;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}
/** Explicitly refreshed catalog. Failed discovery never substitutes guessed or stale capabilities. */
export class CapabilityCatalog {
  private known = new Map<string, ProviderModel>();
  constructor(private readonly options: CapabilityCatalogOptions) {}
  async list(signal?: AbortSignal): Promise<ProviderModel[]> {
    const opts = this.options, path = opts.endpointPath ?? '/models';
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Catalog endpointPath must be relative');
    const url = `${opts.baseUrl.replace(/\/+$/, '')}${path}`;
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const headers = new Headers(opts.headers);
        for (const [key, value] of Object.entries(await opts.auth?.headers() ?? {})) headers.set(key, value);
        const res = await (opts.fetchImpl ?? fetch)(url, { headers, signal: bounded, redirect: 'error' });
        if (!res.ok) {
          await res.body?.cancel();
          if (opts.format !== 'chatgpt' && attempt === 0 && (res.status === 401 || res.status === 403) && await opts.auth?.refresh()) continue;
          // An upstream error body can contain account identifiers or secrets; don't echo it to UI/logs.
          throw new Error(`Model catalog request failed (HTTP ${res.status})`);
        }
        const models = opts.format === 'chatgpt' ? parseChatGPTModels(await res.json()) : parseApiModels(await res.json());
        this.known = new Map(models.map(model => [model.id, structuredClone(model)]));
        return models;
      }
      throw new Error('Model catalog authorization failed');
    } catch (error) { this.known.clear(); throw error; }
  }
  contextWindow(model: string): number | undefined { return this.known.get(model)?.contextWindow; }
  model(id: string): ProviderModel | undefined { const value = this.known.get(id); return value ? structuredClone(value) : undefined; }
  clear(): void { this.known.clear(); }
}

/** Routing only, not entitlement or capabilities. Checked 2026-10-08 against official Go docs.
 * https://opencode.ai/docs/en/go/#endpoints
 * Go is a coding-agent service; exposing this metadata does not authorize ambient inference.
 */
const GO_PROTOCOLS: Readonly<Record<ProtocolKind, readonly string[]>> = {
  responses: ['grok-4.7', 'grok-4.6', 'gpt-6-luna', 'gpt-5.6-luna', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'],
  'anthropic-messages': ['claude-haiku-5-5', 'minimax-m3', 'minimax-m2.7', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus'],
  'chat-completions': ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'longcat-2.0', 'longcat-2.5-preview-free',
    'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.5', 'mimo-v2.5-pro', 'hy4-preview', 'hy3', 'space-bunny'],
};
export function openCodeGoProtocol(model: string): ProtocolKind | undefined {
  return (Object.entries(GO_PROTOCOLS) as Array<[ProtocolKind, readonly string[]]>).find(([, ids]) => ids.includes(model))?.[0];
}
export function protocolEndpoint(protocol: ProtocolKind): string {
  return { responses: '/responses', 'chat-completions': '/chat/completions', 'anthropic-messages': '/messages' }[protocol];
}
