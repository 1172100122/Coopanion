/** Protocol adapters are independent of credentials, provider presets and the settings UI. */
import type { Logger, ModelSpec, ToolSchema } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { GenerationError, priceUsage, standardUsage, unknownMeters, type GenerateOptions, type Generation, type TokenMeters, type ProviderAttempt, type PriceSnapshot } from 'cortico/core/generation.ts';
import { createResponse, type Request, type Response, type OutputItem, type StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { ResponseAccumulator, ResponseProtocolError } from 'cortico/protocol/open-responses/stream.ts';
import { itemText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import { EventDecoder, requestJson } from 'cortico/providers/transport/response-http.ts';
import { abortError } from 'cortico/providers/transport/errors.ts';
import { ChatResponseAssembly, NativeResponseAssembly, normalizeCompletedFunctionCalls, type ResponseAssembly } from 'cortico/providers/transport/response-assembly.ts';
import { responseMeters } from 'cortico/providers/transport/response-meters.ts';
import { buildResponsesBody } from 'cortico/providers/openai-responses-compat/native.ts';
import { requestContext } from 'cortico/providers/transport/native-input.ts';
import { dropPastThinking, mapTools, renderMessagesWithMedia, type CompatMediaOptions } from 'cortico/providers/transport/history.ts';
import type { NativeChatMessage } from 'cortico/providers/transport/native-types.ts';

type Json = Record<string, unknown>;
export interface TransportAuth {
  headers(): Record<string, string> | Promise<Record<string, string>>;
  refresh(): Promise<boolean>;
}
export interface ProtocolProviderOptions {
  baseUrl: string;
  auth?: TransportAuth;
  apiKey?: string;
  endpointPath?: string;
  extraHeaders?: Record<string, string>;
  /** Restricted to non-structural provider options; cannot replace history, tools or streaming. */
  extraBody?: Json;
  media?: CompatMediaOptions;
  keepThinking?: () => boolean;
  log?: Logger;
  forceStream?: boolean;
  /** Stable conversation header, e.g. x-opencode-session. */
  sessionHeader?: string;
}
export interface AuthenticatedResponsesOptions extends ProtocolProviderOptions {
  /** Official Sign in with ChatGPT preview request shape, not API-key Responses. */
  chatgpt?: boolean;
}
export interface AnthropicMessagesOptions extends ProtocolProviderOptions {
  maxOutputTokens?: number;
  thinkingMode?: 'budget' | 'adaptive' | 'off';
}
function object(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResponseProtocolError(`Invalid ${label}`);
  return value as Json;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ResponseProtocolError(`Invalid ${label}`);
  return value;
}
function nonempty(value: unknown, label: string): string {
  const result = string(value, label);
  if (!result) throw new ResponseProtocolError(`Missing ${label}`);
  return result;
}
function argumentsObject(value: string): Json {
  try { return object(JSON.parse(value), 'function arguments (expected JSON object)'); }
  catch { throw new ResponseProtocolError('Function arguments must be a complete JSON object'); }
}
function extras(extra: Json = {}): Json {
  const allowed = new Set(['service_tier', 'reasoning_effort', 'thinking', 'output_config', 'verbosity']);
  for (const key of Object.keys(extra)) if (!allowed.has(key)) throw new Error(`Unsupported provider body override: ${key}`);
  return structuredClone(extra);
}
function safeCalls(response: Response): Response {
  const ids = new Set<string>();
  return { ...response, output: response.output.map(item => {
    if (item.type !== 'function_call') return item;
    if (response.status !== 'completed') return { ...item, status: 'incomplete' };
    if (item.status === 'completed') {
      nonempty(item.id, 'function item id'); nonempty(item.call_id, 'function call id'); nonempty(item.name, 'function name');
      if (ids.has(item.call_id)) throw new ResponseProtocolError('Duplicate function call id');
      ids.add(item.call_id);
      argumentsObject(item.arguments);
    }
    return item;
  }) };
}
/** Never expose completed calls from a failed or truncated generation's diagnostic snapshot. */
function partialCalls(response: Response | null): Response | null {
  return response && { ...response, output: response.output.map(item => item.type === 'function_call' ? { ...item, status: 'incomplete' } : item) };
}
class CheckedAssembly implements ResponseAssembly {
  private deferred: StreamEvent[] = [];
  private holding = false;
  private bufferedCharacters = 0;
  constructor(private readonly inner: ResponseAssembly) {}
  private forward(event: StreamEvent, emit: (event: StreamEvent) => void): void {
    // A call's done event is not permission to execute it before the terminal response.
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') this.holding = true;
    if (this.holding) {
      if ('delta' in event && typeof event.delta === 'string') this.bufferedCharacters += event.delta.length;
      if (this.bufferedCharacters > 4_000_000 || this.deferred.length > 100_000) throw new ResponseProtocolError('Provider exceeded deferred tool output limit');
      this.deferred.push(event);
    }
    else emit(event);
  }
  feed(payload: unknown, emit: (event: StreamEvent) => void): void { this.inner.feed(payload, event => this.forward(event, emit)); }
  finish(emit: (event: StreamEvent) => void): Response {
    const response = safeCalls(this.inner.finish(event => this.forward(event, emit)));
    const calls = new Map(response.output.filter(item => item.type === 'function_call').map(item => [item.id, item]));
    for (const event of this.deferred) {
      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') emit({ ...event, item: calls.get(event.item.id)! });
      else if ('response' in event && ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) emit({ ...event, response });
      else emit(event);
    }
    this.deferred = [];
    return response;
  }
  snapshot(): Response | null { return partialCalls(this.inner.snapshot()); }
  meters(): TokenMeters { return this.inner.meters(); }
  serviceTier(): string | null { return this.inner.serviceTier(); }
}

abstract class AuthenticatedHttpClient extends OpenAIHttpClient {
  constructor(protected readonly opts: ProtocolProviderOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    if (opts.endpointPath && (!opts.endpointPath.startsWith('/') || opts.endpointPath.startsWith('//') || /[?#]/.test(opts.endpointPath)))
      throw new Error('Provider endpointPath must be a relative endpoint path');
    extras(opts.extraBody);
  }
  protected async headers(): Promise<Record<string, string>> {
    const headers = new Headers({ 'Content-Type': 'application/json', ...this.opts.extraHeaders });
    if (this.opts.apiKey) headers.set('Authorization', `Bearer ${this.opts.apiKey}`);
    for (const [key, value] of Object.entries(await this.opts.auth?.headers() ?? {})) headers.set(key, value);
    const result: Record<string, string> = {};
    headers.forEach((value, key) => { result[key] = value; });
    return result;
  }
  protected override async onAuthError(): Promise<boolean> { return await this.opts.auth?.refresh() ?? false; }
  override async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const origin = options.origin ?? { instance: this.constructor.name, module: this.constructor.name, model: request.model ?? '', compatibilityDomain: this.baseUrl };
    const actual = { ...options, origin, ...(this.opts.forceStream && !options.onEvent ? { onEvent: () => {} } : {}) };
    const body = this.buildResponseBody(request, actual);
    const run = (): Promise<Generation> => generateProtocolAttempt(request, actual, `${this.baseUrl}${this.chatPath}`, body,
      async () => ({ ...await this.headers(), ...(this.opts.sessionHeader && options.sessionId ? { [this.opts.sessionHeader]: options.sessionId } : {}) }),
      this.responseAssembly(request), raw => this.parseResponse(raw, request));
    try { return await run(); }
    catch (error) {
      // Only an HTTP authentication rejection may renew and replay once, before any output.
      // Other failures are reported to the caller, never silently retried after side effects.
      if (!(error instanceof GenerationError) || options.diagnostic || ![401, 403].includes(error.status) || error.partial) throw error;
      let refreshed: boolean;
      try { refreshed = await this.onAuthError(); }
      catch (refreshError) { throw new GenerationError('Provider authentication refresh failed', error.attempts, error.partial, error.origin, error.status, error.body, { cause: refreshError }); }
      if (!refreshed) throw error;
      const combine = (attempts: ProviderAttempt[]): ProviderAttempt[] => [...error.attempts, ...attempts.map((attempt, index) => ({ ...attempt,
        generationId: error.attempts[0]?.generationId ?? attempt.generationId, ordinal: error.attempts.length + index }))];
      try { const result = await run(); return { ...result, attempts: combine(result.attempts) }; }
      catch (retry) {
        if (retry instanceof GenerationError) throw new GenerationError(retry.message, combine(retry.attempts), retry.partial, retry.origin, retry.status, retry.body, { cause: retry });
        throw retry;
      }
    }
  }
}

/** Plain Chat Completions, with no llama.cpp-specific template controls. */
export class GenericChatProvider extends AuthenticatedHttpClient {
  constructor(opts: ProtocolProviderOptions) { super(opts); this.chatPath = opts.endpointPath ?? '/chat/completions'; }
  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[]): Json {
    const body: Json = { ...extras(this.opts.extraBody), model: spec.model,
      messages: renderMessagesWithMedia(this.opts.keepThinking?.() === false ? dropPastThinking(messages) : messages, this.opts.media, { keepReasoning: spec.thinking }) };
    if (spec.reasoningEffort && spec.thinking) body.reasoning_effort = spec.reasoningEffort;
    if (spec.temperature !== undefined) body.temperature = spec.temperature;
    if (spec.maxTokens !== undefined) body.max_tokens = spec.maxTokens;
    const mapped = mapTools(tools);
    if (mapped) body.tools = mapped;
    return body;
  }
  protected override responseAssembly(request: Request): ResponseAssembly { return new CheckedAssembly(new ChatResponseAssembly(request)); }
  protected override parseResponse(raw: unknown, request: Request): { response: Response; meters: TokenMeters; serviceTier: string | null } {
    const parsed = super.parseResponse(raw, request);
    return { ...parsed, response: safeCalls(parsed.response) };
  }
}

/** API-key and OAuth Responses share parsing but not necessarily their accepted request fields. */
export class AuthenticatedResponsesProvider extends AuthenticatedHttpClient {
  constructor(private readonly responseOpts: AuthenticatedResponsesOptions) {
    super({ ...responseOpts, forceStream: responseOpts.chatgpt || responseOpts.forceStream });
    if (responseOpts.chatgpt && (responseOpts.baseUrl.replace(/\/+$/, '') !== 'https://api.openai.com/v1' || responseOpts.endpointPath && responseOpts.endpointPath !== '/responses'))
      throw new Error('ChatGPT authorization may only be sent to the official OpenAI Responses endpoint');
    this.chatPath = responseOpts.endpointPath ?? '/responses';
  }
  override async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    if (!this.responseOpts.chatgpt) return super.respond(request, options);
    const origin = options.origin ?? { instance: this.constructor.name, module: this.constructor.name, model: request.model ?? '', compatibilityDomain: this.baseUrl };
    const actual = { ...options, origin, onEvent: options.onEvent ?? (() => {}) };
    return generateProtocolAttempt(request, actual, `${this.baseUrl}${this.chatPath}`, this.buildResponseBody(request, actual), () => this.headers(), this.responseAssembly(), raw => this.parseResponse(raw, request), true);
  }
  protected buildBody(): never { throw new Error('Responses does not build Chat Completions bodies'); }
  protected override buildResponseBody(request: Request, options: GenerateOptions): Json {
    const body = buildResponsesBody(request, options, { media: this.opts.media, keepThinking: this.opts.keepThinking, reasoningReplay: 'encrypted' }, extras(this.opts.extraBody));
    if (!this.responseOpts.chatgpt) return body;
    // https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
    const allowed = new Set(['model', 'input', 'instructions', 'reasoning', 'text', 'tools', 'tool_choice', 'parallel_tool_calls', 'include', 'prompt_cache_key', 'service_tier']);
    const result: Json = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.has(key)));
    result.store = false;
    result.stream = true;
    if (request.tools?.some(tool => tool.type !== 'function')) throw new Error('ChatGPT supports only local function tools in this adapter');
    if (request.tools?.length) result.tools = [{ type: 'namespace', name: 'coopanion', description: 'Local Coopanion tools', tools: request.tools }];
    if (Array.isArray(result.input)) result.input = result.input.map(item => {
      const value = object(item, 'Responses input item');
      return value.type === 'function_call' ? { ...value, namespace: 'coopanion' } : value;
    });
    if (request.tool_choice && typeof request.tool_choice === 'object') {
      if (request.tool_choice.type !== 'function') throw new Error('ChatGPT adapter does not support allowed_tools tool choice');
      result.tool_choice = { ...request.tool_choice, namespace: 'coopanion' };
    }
    return result;
  }
  protected override responseAssembly(): ResponseAssembly { return new CheckedAssembly(new NativeResponseAssembly()); }
  protected override parseResponse(raw: unknown, request: Request): { response: Response; meters: TokenMeters; serviceTier: string | null } {
    const data = object(raw, 'Responses resource');
    if (typeof data.id !== 'string' || typeof data.model !== 'string' || !Array.isArray(data.output) || !['completed', 'incomplete', 'failed'].includes(String(data.status)))
      throw new ResponseProtocolError('Invalid native Responses resource');
    const meters = responseMeters(data.usage as Json | null);
    const response = normalizeCompletedFunctionCalls({ ...createResponse(data.id, request), ...data, usage: standardUsage(meters) });
    return { response: safeCalls(response), meters, serviceTier: typeof data.service_tier === 'string' ? data.service_tier : null };
  }
}
export { AuthenticatedResponsesProvider as OAuthResponsesProvider };

const SUBSCRIPTION_ERROR_CODES = new Set([
  'subscription_sharing_user_not_eligible', 'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable',
  'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported', 'subscription_sharing_invalid_user',
  'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context', 'subscription_sharing_user_unavailable',
  'invalid_token', 'token_expired', 'invalid_api_key', 'rate_limit_exceeded', 'inference_failed',
]);
function subscriptionDiagnostic(raw: unknown): { code: string; message: string; param?: string } {
  const value = raw && typeof raw === 'object' ? raw as Json : {};
  const code = typeof value.code === 'string' && SUBSCRIPTION_ERROR_CODES.has(value.code) ? value.code : 'inference_failed';
  const params = new Set(['model', 'input', 'tools', 'tool_choice', 'reasoning', 'reasoning.effort', 'temperature', 'top_p', 'max_output_tokens', 'stream', 'store', 'instructions', 'include']);
  const param = typeof value.param === 'string' && params.has(value.param) ? value.param : undefined;
  return { code, message: 'ChatGPT inference did not complete. Check the connection and selected model.', ...(param ? { param } : {}) };
}
function safeSubscriptionEvent(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const event = payload as Json;
  if (event.type === 'error') return { type: 'error', sequence_number: event.sequence_number, ...subscriptionDiagnostic(event.error ?? event), error: subscriptionDiagnostic(event.error ?? event) };
  if (event.response && typeof event.response === 'object') {
    const response = event.response as Json;
    if (response.error) return { ...event, response: { ...response, error: subscriptionDiagnostic(response.error) } };
  }
  return payload;
}

/** A bounded, redirect-blocking attempt using Cortico framing, assembly, metering and pricing.
 * Cortico's generic HTTP loop follows redirects and retries quota errors. Neither is appropriate
 * for subscription credentials; custom headers such as x-api-key also require redirect blocking.
 * Callers own the narrowly scoped refresh policy; SIWC never automatically replays inference.
 */
async function generateProtocolAttempt(request: Request, options: GenerateOptions, url: string, body: Json,
  headers: () => Promise<Record<string, string>>, assembly: ResponseAssembly,
  parse: (raw: unknown) => { response: Response; meters: TokenMeters; serviceTier: string | null }, requireCompleted = false): Promise<Generation> {
  const origin = options.origin!;
  const started = Date.now();
  const attempt: ProviderAttempt = {
    id: crypto.randomUUID(), generationId: crypto.randomUUID(), ordinal: 0, origin: structuredClone(origin), startedAt: new Date().toISOString(), elapsedMs: 0,
    requestId: null, responseId: null, outcome: 'failed', status: null, serviceTier: null, requestedServiceTier: request.service_tier ?? null,
    purpose: options.diagnostic ? 'diagnostic' : 'generation', meters: unknownMeters(), charges: [],
  };
  const attempts: ProviderAttempt[] = [];
  let quotes: readonly PriceSnapshot[] = [];
  let sent = false, status = 0, errorBody = '', partial: Response | null = null;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const streaming = Boolean(options.onEvent);
  let timer = setTimeout(() => controller.abort(new Error('Provider first response timeout')), streaming ? 300_000 : 120_000);
  let contentTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortReader = (): void => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener('abort', abortReader, { once: true });
  const checkAbort = (): void => { if (signal.aborted) throw abortError(signal); };
  let characters = 0;
  const forward = (event: StreamEvent): void => {
    checkAbort();
    if ('delta' in event || event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      clearTimeout(contentTimer);
      contentTimer = setTimeout(() => controller.abort(new Error('Provider stream content idle timeout')), 300_000);
    }
    if ('delta' in event && typeof event.delta === 'string') characters += event.delta.length;
    if (characters > (request.max_output_tokens ?? 32768) * 12) throw new ResponseProtocolError('Provider exceeded the output character limit');
    options.onEvent?.(event);
  };
  try {
    checkAbort();
    const authHeaders = await headers();
    checkAbort();
    attempt.startedAt = new Date().toISOString();
    quotes = structuredClone(options.quote?.({ startedAt: attempt.startedAt, requestedServiceTier: attempt.requestedServiceTier ?? null }) ?? []);
    sent = true;
    const response = await fetch(url, { method: 'POST', body: requestJson(body), headers: authHeaders, signal, redirect: 'error' });
    status = response.status;
    attempt.status = status;
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('openai-request-id');
    attempt.requestId = requestId && /^[A-Za-z0-9_-]{1,150}$/.test(requestId) ? requestId : null;
    if (!response.ok) {
      errorBody = await response.text();
      if (requireCompleted) {
        let diagnostic: unknown;
        try { const parsed = JSON.parse(errorBody); diagnostic = parsed.error ?? parsed; } catch { diagnostic = {}; }
        errorBody = JSON.stringify({ error: subscriptionDiagnostic(diagnostic) });
      }
      let code = '';
      try { const error = object(object(JSON.parse(errorBody), 'error response').error, 'error'); code = String(error.code ?? error.type ?? ''); } catch { /* Keep original response in GenerationError.body. */ }
      throw new Error(`Provider request failed (HTTP ${status}${code ? `, ${code}` : ''})`);
    }
    if (streaming) {
      if (!response.body) throw new ResponseProtocolError('Provider streaming response has no body');
      reader = response.body.getReader();
      const frames = new EventDecoder(), decoder = new TextDecoder();
      contentTimer = setTimeout(() => controller.abort(new Error('Provider stream content idle timeout')), 300_000);
      stream: for (;;) {
        checkAbort();
        const chunk = await reader.read();
        checkAbort();
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error('Provider stream idle timeout')), 120_000);
        if (chunk.done) break;
        for (const payload of frames.feed(decoder.decode(chunk.value, { stream: true }))) {
          if (payload === '[DONE]') break stream;
          const event = (requireCompleted ? safeSubscriptionEvent(JSON.parse(payload)) : JSON.parse(payload)) as Json;
          if (event?.type === 'error' || event?.type === 'response.failed') errorBody = JSON.stringify(event.error ?? (event.response as Json | undefined)?.error ?? event);
          assembly.feed(event, forward);
        }
      }
      partial = assembly.finish(forward);
      attempt.meters = assembly.meters();
      attempt.serviceTier = assembly.serviceTier();
    } else {
      const parsed = parse(await response.json());
      partial = parsed.response;
      attempt.meters = parsed.meters;
      attempt.serviceTier = parsed.serviceTier;
    }
    attempt.responseId = partial.id;
    if (partial.status !== 'completed' && (requireCompleted || partial.status !== 'incomplete')) {
      errorBody = JSON.stringify(partial.error ?? partial.incomplete_details);
      throw new Error(`Provider response ${partial.status}: ${partial.error?.code ?? partial.incomplete_details?.reason ?? 'unknown'}${partial.error?.message ? ` (${partial.error.message})` : ''}`);
    }
    checkAbort();
    attempt.outcome = partial.status === 'completed' ? 'completed' : 'incomplete';
    return { response: partial, origin, attempts };
  } catch (error) {
    partial = partialCalls(partial ?? assembly.snapshot());
    attempt.responseId = partial?.id ?? null;
    if (streaming) attempt.meters = assembly.meters();
    if (!errorBody && partial?.error) errorBody = JSON.stringify(partial.error);
    if (options.signal?.aborted) attempt.outcome = 'aborted';
    if (requireCompleted) {
      if (partial?.error) partial = { ...partial, error: subscriptionDiagnostic(partial.error) };
      let diagnostic: unknown;
      try { const parsed = JSON.parse(errorBody); diagnostic = parsed.error ?? parsed; } catch { diagnostic = {}; }
      const safe = subscriptionDiagnostic(diagnostic);
      errorBody = JSON.stringify({ error: safe });
      throw new GenerationError(options.signal?.aborted ? 'ChatGPT request was canceled' : `${safe.message} (${safe.code})`, attempts, partial, origin, status, errorBody);
    }
    throw new GenerationError(error instanceof Error ? error.message : String(error), attempts, partial, origin, status, errorBody, { cause: error });
  } finally {
    clearTimeout(timer); clearTimeout(contentTimer);
    signal.removeEventListener('abort', abortReader);
    if (reader) { try { await reader.cancel(); } catch { /* stream already closed */ } reader.releaseLock(); }
    attempt.elapsedMs = Date.now() - started;
    attempt.charges = priceUsage(attempt.meters, quotes, attempt.serviceTier);
    if (sent) attempts.push(attempt);
  }
}

const ANTHROPIC_REPLAY = 'anthropic-thinking-v1:';
function imagePart(url: string): Json {
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Anthropic image requires a supported data URL or HTTPS URL'); }
  if (parsed.protocol !== 'https:') throw new Error('Anthropic image URL must use HTTPS');
  return { type: 'image', source: { type: 'url', url } };
}
function anthropicParts(value: unknown, entry: ContextRecord, media?: CompatMediaOptions): Json[] {
  const parts: Json[] = typeof value === 'string' ? (value ? [{ type: 'text', text: value }] : []) : (Array.isArray(value) ? value.map(raw => {
    const part = object(raw, 'Anthropic input content');
    if (part.type === 'input_text' || part.type === 'output_text') return { type: 'text', text: string(part.text, 'text') };
    if (part.type === 'refusal') return { type: 'text', text: string(part.refusal, 'refusal') };
    if (part.type === 'input_image') return imagePart(nonempty(part.image_url, 'image URL'));
    throw new Error(`Anthropic Messages cannot replay content part ${part.type}`);
  }) : []);
  if (media?.enabled()) for (const ref of entry.context.blobs ?? []) {
    if (!ref.mime.startsWith('image/')) continue;
    const data = media.read(ref.handle);
    if (data) parts.push(imagePart(`data:${ref.mime};base64,${data.toString('base64')}`));
  }
  return parts;
}
function sameOrigin(entry: ContextRecord, options: GenerateOptions): boolean {
  const a = entry.context.origin, b = options.origin;
  return !!a && !!b && a.instance === b.instance && a.module === b.module && a.model === b.model && a.compatibilityDomain === b.compatibilityDomain;
}
/** Signed thinking is opaque replay data. Never synthesize signatures or replay between providers. */
export function buildAnthropicBody(request: Request, options: GenerateOptions, opts: AnthropicMessagesOptions): Json {
  const entries = requestContext(request, options);
  const system = request.instructions ? [request.instructions] : [];
  const messages: Array<{ role: 'user' | 'assistant'; content: Json[] }> = [];
  const push = (role: 'user' | 'assistant', content: Json[]): void => {
    if (!content.length) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...content);
    else messages.push({ role, content });
  };
  let lastUser = -1;
  entries.forEach((entry, index) => { if (entry.item.type === 'message' && entry.item.role === 'user') lastUser = index; });
  entries.forEach((entry, index) => {
    const item = entry.item;
    if (item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') { system.push(itemText(item)); return; }
      push(item.role, anthropicParts(item.content, entry, opts.media));
    } else if (item.type === 'function_call') {
      if (item.status === 'incomplete' || item.status === 'in_progress') throw new Error('Cannot replay an incomplete Anthropic tool call');
      push('assistant', [{ type: 'tool_use', id: item.call_id, name: item.name, input: argumentsObject(item.arguments) }]);
    } else if (item.type === 'function_call_output') {
      push('user', [{ type: 'tool_result', tool_use_id: item.call_id, content: anthropicParts(item.output, entry, opts.media) }]);
    } else if (item.type === 'reasoning') {
      if (!item.encrypted_content?.startsWith(ANTHROPIC_REPLAY) || !sameOrigin(entry, options)) return;
      // Thinking for the current tool round is required even with past-thinking retention disabled.
      if (index < lastUser && !entry.context.head && opts.keepThinking?.() === false) return;
      let block: Json;
      try { block = object(JSON.parse(Buffer.from(item.encrypted_content.slice(ANTHROPIC_REPLAY.length), 'base64').toString('utf8')), 'thinking replay'); }
      catch { throw new Error('Invalid Anthropic signed thinking replay'); }
      if (block.type === 'thinking') { string(block.thinking, 'thinking'); nonempty(block.signature, 'thinking signature'); }
      else if (block.type === 'redacted_thinking') nonempty(block.data, 'redacted thinking');
      else throw new Error('Unsupported Anthropic signed thinking replay');
      push('assistant', [block]);
    } else throw new Error(`Anthropic Messages cannot replay ${item.type}`);
  });
  const maxTokens = request.max_output_tokens ?? options.nativeSpec?.maxTokens ?? opts.maxOutputTokens ?? 8192;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('Anthropic max_tokens must be a positive integer');
  const body: Json = { ...extras(opts.extraBody), model: request.model, max_tokens: maxTokens, messages, stream: Boolean(options.onEvent) };
  if (system.length) body.system = system.join('\n');
  if (request.temperature != null) body.temperature = request.temperature;
  if (request.top_p != null) body.top_p = request.top_p;
  if (request.tools?.length) body.tools = request.tools.map(tool => {
    if (tool.type !== 'function') throw new Error('Anthropic adapter supports only local function tools');
    return { name: tool.name, description: tool.description ?? '', input_schema: tool.parameters ?? { type: 'object', properties: {} } };
  });
  const choice = request.tool_choice;
  if (choice != null) {
    if (typeof choice === 'string') body.tool_choice = { type: choice === 'required' ? 'any' : choice };
    else if (choice.type === 'function') body.tool_choice = { type: 'tool', name: choice.name };
    else throw new Error('Anthropic Messages cannot map allowed_tools tool choice');
  }
  if (request.parallel_tool_calls === false && request.tools?.length) body.tool_choice = { ...object(body.tool_choice ?? { type: 'auto' }, 'tool choice'), disable_parallel_tool_use: true };
  const effort = request.reasoning?.effort ?? options.nativeSpec?.reasoningEffort;
  if (effort && effort !== 'none' && opts.thinkingMode !== 'off') {
    if (opts.thinkingMode === 'adaptive') body.thinking = { type: 'adaptive' };
    else {
      if (maxTokens <= 1024) throw new Error('Anthropic thinking requires max_output_tokens greater than 1024');
      const budget = ({ minimal: 1024, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 } as Record<string, number>)[effort] ?? 4096;
      body.thinking = { type: 'enabled', budget_tokens: Math.min(budget, maxTokens - 1) };
    }
    delete body.temperature;
    delete body.top_p;
    if (choice === 'required' || typeof choice === 'object' && choice?.type === 'function') throw new Error('Anthropic thinking does not support forced tool choice');
  }
  if (request.text?.format && request.text.format.type !== 'text') throw new Error('Anthropic Messages structured output requires a model-specific configuration');
  return body;
}

interface AnthropicBlock {
  native: Json;
  item: Json;
  json: string;
  closed: boolean;
}
/** Messages SSE -> the same strict Open Responses events consumed by Cortico. */
export class AnthropicResponseAssembly implements ResponseAssembly {
  private readonly response: Response;
  private readonly accumulator = new ResponseAccumulator();
  private readonly blocks: AnthropicBlock[] = [];
  private sequence = 0;
  private started = false;
  private stopped = false;
  private reason: string | null = null;
  private usage: Json = {};
  constructor(request: Request) { this.response = createResponse(`resp_${crypto.randomUUID()}`, request); }
  private send(event: Json, emit: (event: StreamEvent) => void): void {
    const full = structuredClone({ ...event, sequence_number: this.sequence++ }) as StreamEvent;
    this.accumulator.accept(full);
    emit(full);
  }
  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    const event = object(payload, 'Anthropic event');
    if (event.type === 'error') { const error = object(event.error, 'Anthropic error'); throw new ResponseProtocolError(`Anthropic ${error.type ?? 'error'}: ${error.message ?? 'stream failed'}`); }
    if (event.type === 'ping') return;
    if (this.stopped) throw new ResponseProtocolError('Anthropic event after message_stop');
    if (event.type === 'message_start') {
      if (this.started) throw new ResponseProtocolError('Duplicate Anthropic message_start');
      const message = object(event.message, 'Anthropic message');
      this.response.id = nonempty(message.id, 'message id');
      this.response.model = nonempty(message.model, 'message model');
      if (Array.isArray(message.content) && message.content.length) throw new ResponseProtocolError('Anthropic message_start content must be empty');
      this.usage = { ...object(message.usage ?? {}, 'usage') };
      this.started = true;
      this.send({ type: 'response.created', response: this.response }, emit);
      return;
    }
    if (!this.started) throw new ResponseProtocolError('Anthropic event before message_start');
    if (event.type === 'message_delta') {
      const delta = object(event.delta, 'message delta');
      if (delta.stop_reason != null) this.reason = nonempty(delta.stop_reason, 'stop reason');
      this.usage = { ...this.usage, ...object(event.usage ?? {}, 'usage') };
      return;
    }
    if (event.type === 'message_stop') { this.stopped = true; return; }
    if (!['content_block_start', 'content_block_delta', 'content_block_stop'].includes(String(event.type))) return; // Future non-content events are ignorable.
    const index = event.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new ResponseProtocolError('Invalid Anthropic block index');
    if (event.type === 'content_block_start') {
      if (index !== this.blocks.length) throw new ResponseProtocolError('Non-contiguous Anthropic block index');
      const native = structuredClone(object(event.content_block, 'content block'));
      let item: Json;
      if (native.type === 'text') item = { type: 'message', id: `msg_${crypto.randomUUID()}`, role: 'assistant', status: 'in_progress', content: [] };
      else if (native.type === 'tool_use') item = { type: 'function_call', id: `fc_${crypto.randomUUID()}`, call_id: nonempty(native.id, 'tool id'), name: nonempty(native.name, 'tool name'), arguments: '', status: 'in_progress' };
      else if (native.type === 'thinking' || native.type === 'redacted_thinking') item = { type: 'reasoning', id: `rs_${crypto.randomUUID()}`, summary: [], content: [] };
      else throw new ResponseProtocolError(`Unsupported Anthropic content block: ${native.type}`);
      if (native.type === 'tool_use' && this.blocks.some(block => block.item.type === 'function_call' && block.item.call_id === item.call_id))
        throw new ResponseProtocolError('Duplicate Anthropic tool id');
      this.blocks.push({ native, item, json: '', closed: false });
      this.send({ type: 'response.output_item.added', output_index: index, item }, emit);
      if (native.type === 'text' || native.type === 'thinking') {
        const part = native.type === 'text' ? { type: 'output_text', text: '', annotations: [] } : { type: 'reasoning_text', text: '' };
        this.send({ type: 'response.content_part.added', output_index: index, item_id: item.id, content_index: 0, part }, emit);
        item.content = [part];
        const initial = string(native[native.type === 'text' ? 'text' : 'thinking'] ?? '', 'initial text');
        if (initial) this.text(index, initial, emit);
      }
      return;
    }
    const block = this.blocks[index];
    if (!block || block.closed) throw new ResponseProtocolError('Anthropic update to missing or closed block');
    if (event.type === 'content_block_stop') { block.closed = true; return; }
    const delta = object(event.delta, 'content delta');
    if (delta.type === 'text_delta' && block.native.type === 'text') this.text(index, string(delta.text, 'text delta'), emit);
    else if (delta.type === 'thinking_delta' && block.native.type === 'thinking') this.text(index, string(delta.thinking, 'thinking delta'), emit);
    else if (delta.type === 'signature_delta' && block.native.type === 'thinking') block.native.signature = String(block.native.signature ?? '') + string(delta.signature, 'signature delta');
    else if (delta.type === 'input_json_delta' && block.native.type === 'tool_use') {
      const fragment = string(delta.partial_json, 'tool JSON delta');
      block.json += fragment;
      block.item.arguments = block.json;
      this.send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: block.item.id, delta: fragment }, emit);
    } else throw new ResponseProtocolError(`Unsupported or mismatched Anthropic delta: ${delta.type}`);
  }
  private text(index: number, text: string, emit: (event: StreamEvent) => void): void {
    const block = this.blocks[index];
    const reasoning = block.native.type === 'thinking';
    const part = (block.item.content as Json[])[0];
    part.text = String(part.text) + text;
    block.native[reasoning ? 'thinking' : 'text'] = part.text;
    this.send({ type: reasoning ? 'response.reasoning.delta' : 'response.output_text.delta', output_index: index, item_id: block.item.id, content_index: 0, delta: text, ...(!reasoning ? { logprobs: [] } : {}) }, emit);
  }
  finish(emit: (event: StreamEvent) => void): Response {
    if (!this.stopped || !this.reason || this.blocks.some(block => !block.closed)) throw new ResponseProtocolError('Anthropic stream ended before message_stop or a content block completed');
    const incomplete = ['max_tokens', 'model_context_window_exceeded', 'pause_turn'].includes(this.reason);
    if (!incomplete && !['end_turn', 'tool_use', 'stop_sequence', 'refusal'].includes(this.reason)) throw new ResponseProtocolError(`Unsupported Anthropic stop_reason: ${this.reason}`);
    // Validate every tool before emitting any completed tool item.
    for (const block of this.blocks) if (block.native.type === 'tool_use' && !incomplete) argumentsObject(block.json || JSON.stringify(object(block.native.input ?? {}, 'tool input')));
    for (const [index, block] of this.blocks.entries()) {
      const { item, native } = block;
      if (native.type === 'tool_use') {
        if (!block.json) {
          const args = JSON.stringify(object(native.input ?? {}, 'tool input'));
          item.arguments = args;
          this.send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: args }, emit);
        }
        this.send({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments }, emit);
        item.status = incomplete ? 'incomplete' : 'completed';
      } else {
        if (native.type === 'thinking' && typeof native.signature === 'string' && native.signature || native.type === 'redacted_thinking')
          item.encrypted_content = ANTHROPIC_REPLAY + Buffer.from(JSON.stringify(native)).toString('base64');
        if (native.type === 'text' || native.type === 'thinking') this.send({ type: 'response.content_part.done', output_index: index, item_id: item.id, content_index: 0, part: (item.content as Json[])[0] }, emit);
        if (native.type === 'text') item.status = incomplete ? 'incomplete' : 'completed';
      }
      this.send({ type: 'response.output_item.done', output_index: index, item }, emit);
    }
    this.response.output = this.blocks.map(block => block.item) as OutputItem[];
    this.response.status = incomplete ? 'incomplete' : 'completed';
    this.response.incomplete_details = incomplete ? { reason: this.reason === 'max_tokens' ? 'max_output_tokens' : this.reason } : null;
    this.response.completed_at = Math.floor(Date.now() / 1000);
    this.response.usage = standardUsage(this.meters());
    this.send({ type: `response.${this.response.status}`, response: this.response }, emit);
    return this.accumulator.finish();
  }
  snapshot(): Response | null { return partialCalls(this.accumulator.snapshot()); }
  serviceTier(): string | null { return typeof this.usage.service_tier === 'string' ? this.usage.service_tier : null; }
  meters(): TokenMeters {
    const count = (key: string): number | null => typeof this.usage[key] === 'number' && Number.isFinite(this.usage[key]) && Number(this.usage[key]) >= 0 ? Number(this.usage[key]) : null;
    const uncached = count('input_tokens'), output = count('output_tokens');
    const cached = count('cache_read_input_tokens') ?? 0, written = count('cache_creation_input_tokens') ?? 0;
    const input = uncached === null ? null : uncached + cached + written;
    return { ...unknownMeters(), input, output, total: input === null || output === null ? null : input + output, cachedInput: cached, uncachedInput: input === null ? null : input - cached,
      native: structuredClone(this.usage), details: { cacheCreationInput: { quantity: written, unit: 'token' } } };
  }
}

export class AnthropicMessagesProvider extends AuthenticatedHttpClient {
  constructor(private readonly anthropicOpts: AnthropicMessagesOptions) { super(anthropicOpts); this.chatPath = anthropicOpts.endpointPath ?? '/messages'; }
  protected buildBody(): never { throw new Error('Anthropic does not build Chat Completions bodies'); }
  protected override buildResponseBody(request: Request, options: GenerateOptions): Json { return buildAnthropicBody(request, options, this.anthropicOpts); }
  protected override async headers(): Promise<Record<string, string>> {
    const headers = new Headers(await super.headers());
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
    // API-key Messages uses x-api-key; OAuth or gateways may provide their own Authorization.
    if (this.opts.apiKey && !this.opts.auth) { headers.delete('authorization'); headers.set('x-api-key', this.opts.apiKey); }
    const result: Record<string, string> = {};
    headers.forEach((value, key) => { result[key] = value; });
    return result;
  }
  protected override responseAssembly(request: Request): ResponseAssembly { return new AnthropicResponseAssembly(request); }
  protected override parseResponse(raw: unknown, request: Request): { response: Response; meters: TokenMeters; serviceTier: string | null } {
    const data = object(raw, 'Anthropic message');
    if (data.type !== 'message' || !Array.isArray(data.content)) throw new ResponseProtocolError('Invalid Anthropic message resource');
    const assembly = new AnthropicResponseAssembly(request), emit = (): void => {};
    assembly.feed({ type: 'message_start', message: { ...data, content: [] } }, emit);
    data.content.forEach((block, index) => {
      assembly.feed({ type: 'content_block_start', index, content_block: block }, emit);
      assembly.feed({ type: 'content_block_stop', index }, emit);
    });
    assembly.feed({ type: 'message_delta', delta: { stop_reason: data.stop_reason }, usage: data.usage }, emit);
    assembly.feed({ type: 'message_stop' }, emit);
    return { response: assembly.finish(emit), meters: assembly.meters(), serviceTier: assembly.serviceTier() };
  }
}
