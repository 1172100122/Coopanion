/// <reference lib="dom" />
/** Browser-only connection controls. Credentials and OAuth URLs never come back from the host. */
export type ConnectionService = 'chatgpt' | 'xai' | 'opencode-go' | 'custom';
export type ConnectionProtocol = 'responses' | 'chat-completions' | 'anthropic-messages';
export interface ConnectionModel { id: string; displayName?: string; inputImages?: boolean; contextWindow?: number; maxOutputTokens?: number }
export interface ConnectionEntry {
  kind: string;
  baseUrl: string;
  secret?: string;
  spec?: { model: string; thinking: boolean; maxTokens?: number; contextWindow?: number; [key: string]: unknown };
  options?: { service?: string; protocol?: string; inputImages?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}
export interface AccountState {
  status: 'signed-out' | 'authorizing' | 'connected' | 'expired' | 'error';
  message?: string;
  account?: string;
  accounts?: Array<{ id: string; label?: string; email?: string }>;
  authenticated?: boolean;
  planUsageEnabled?: boolean;
  models?: ConnectionModel[];
  entry?: ConnectionEntry;
}
export type ConnectionCall = <T>(path: string, body?: unknown, options?: { signal?: AbortSignal; keepalive?: boolean }) => Promise<T>;
interface Detail { name: string; entry: ConnectionEntry; revision: string; secretConfigured?: string }
interface Service { id: ConnectionService; name: string; label: string; baseUrl: string; protocol: ConnectionProtocol }
const NAMES: Record<ConnectionService, string> = { chatgpt: 'chatgpt-plan', xai: 'xai-api', 'opencode-go': 'opencode-go', custom: 'custom-connection' };
export const ACCOUNT_PATH = '/api/console/providers/llm%3Aconnections/panels/accounts/';
export const PENDING_MODEL = 'pending-selection';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const TEXT = {
  en: {
    title: 'Subscriptions & compatible APIs', chatgpt: 'ChatGPT subscription', xai: 'xAI API key', go: 'OpenCode Go', custom: 'Custom API',
    chatgptNote: 'Sign in with an eligible ChatGPT plan in your system browser. Subscription limits apply. An API key is a separate connection, never an automatic fallback.',
    xaiNote: 'xAI API usage is billed separately from Grok subscriptions. Subscription sign-in needs supported registration for this app and is not available here.',
    goNote: 'Coding tasks only. The current always-on companion mode is not supported. Go setup and activation are unavailable until a separate coding-task mode exists. Subscription limits and the provider’s billing settings still apply; no automatic paid fallback is enabled.',
    customNote: 'Use your own provider URL and API key. Select the protocol the provider documents. Usage may be billed by that provider.',
    signedOut: 'Not connected', authorizing: 'Waiting for browser sign-in', connected: 'Connected', expired: 'Sign-in expired', error: 'Connection needs attention',
    savedAccounts: 'Saved accounts', chooseAccount: 'Choose an account', switchAccount: 'Use selected account', newAccount: 'Use another account', enablePlan: 'Enable subscription usage', planDisabled: 'Signed in; subscription usage is disabled', planDisabledNote: 'You are signed in, but subscription usage has not been enabled for this app. Enable it explicitly to load models and run the companion.',
    login: 'Sign in with ChatGPT', cancel: 'Cancel sign-in', logout: 'Sign out', xaiLogin: 'Grok subscription sign-in unavailable',
    key: 'API key', keepKey: 'Leave blank to keep the saved key', save: 'Save key & load models', refresh: 'Refresh models',
    base: 'Base URL', protocol: 'API protocol', model: 'Model', selectModel: 'Choose a model', images: 'This model supports image input (check the provider’s documentation)',
    testActivate: 'Test & activate', testNote: 'Testing sends a small request and may consume plan usage or API credit. The companion starts only after the test passes.',
    working: 'Working…', testing: 'Testing the selected connection…', started: 'Connection tested and activated. The companion is awake.',
    noModel: 'Choose a model before testing.', keyRequired: 'Enter an API key to save this connection.', signInRequired: 'Sign in before testing this connection.',
    saved: 'Key saved. Choose a model, then test and activate.', modelError: 'Models could not be loaded. You can retry.',
    canceled: 'Sign-in canceled.', failedTest: 'Connection test failed. The active provider was not changed.',
    goUnavailable: 'Coding tasks only; unavailable in always-on companion mode', docs: 'OpenCode Go documentation',
    invalidUrl: 'Use an HTTPS base URL, or an HTTP URL on localhost, without a username, password, query or fragment.',
    collision: 'This connection name belongs to a different provider. Manage it on the advanced Model page.',
  },
  zh: {
    title: '订阅与兼容 API', chatgpt: 'ChatGPT 订阅', xai: 'xAI API Key', go: 'OpenCode Go', custom: '自定义 API',
    chatgptNote: '在系统浏览器中登录符合条件的 ChatGPT 订阅。受订阅额度限制。API Key 是独立连接，不会自动切换为付费 API。',
    xaiNote: 'xAI API 独立计费，不包含在 Grok 订阅中。订阅登录需要受支持的本应用注册，目前不可用。',
    goNote: '仅限编码任务。当前常驻陪伴模式不支持；在提供独立编码任务模式之前，无法配置或启用 Go。仍受订阅额度与服务方计费设置限制，不会自动切换为付费 API。',
    customNote: '填写服务方的 URL 和 API Key，并选择其文档支持的协议。使用可能产生服务方的 API 费用。',
    signedOut: '未连接', authorizing: '等待浏览器登录', connected: '已连接', expired: '登录已过期', error: '连接需要处理',
    savedAccounts: '已保存的账号', chooseAccount: '选择账号', switchAccount: '使用所选账号', newAccount: '使用其他账号', enablePlan: '启用订阅额度', planDisabled: '已登录；尚未启用订阅额度', planDisabledNote: '账号已登录，但尚未授权本应用使用订阅额度。请明确启用后再加载模型并启动陪伴。',
    login: '使用 ChatGPT 登录', cancel: '取消登录', logout: '退出登录', xaiLogin: 'Grok 订阅登录暂不可用',
    key: 'API Key', keepKey: '留空沿用已保存的 Key', save: '保存 Key 并加载模型', refresh: '刷新模型',
    base: 'API 基础 URL', protocol: 'API 协议', model: '模型', selectModel: '选择模型', images: '此模型支持图片输入（请核对服务方文档）',
    testActivate: '测试并启用', testNote: '测试会发送一次小请求，可能消耗订阅额度或 API 余额。仅在测试成功后启动陪伴。',
    working: '处理中…', testing: '正在测试所选连接…', started: '连接测试成功并已启用，桌宠已唤醒。',
    noModel: '请先选择模型。', keyRequired: '请填写此连接的 API Key。', signInRequired: '请先登录，再测试连接。',
    saved: 'Key 已保存。请选择模型，再测试并启用。', modelError: '无法加载模型，可以重试。',
    canceled: '已取消登录。', failedTest: '连接测试失败，未更改当前使用的服务。',
    goUnavailable: '仅编码任务；当前持续陪伴模式不支持', docs: 'OpenCode Go 文档',
    invalidUrl: '请使用 HTTPS 地址，或 localhost 上的 HTTP 地址，且不含用户名、密码、查询参数或片段。',
    collision: '此连接名称已用于其他服务，请在高级模式的「模型」页管理。',
  },
};

/** No module state: each mount owns its requests, timer and any sign-in it starts. */
export function mountConnections(options: {
  root: HTMLElement; signal: AbortSignal; call: ConnectionCall; language: 'zh' | 'en'; onActivated?: () => void | Promise<void>;
}): { dispose(): void; refresh(): Promise<void> } {
  const { root, signal, call } = options;
  const doc = root.ownerDocument;
  const S = TEXT[options.language];
  const services: Service[] = [
    { id: 'chatgpt', name: NAMES.chatgpt, label: S.chatgpt, baseUrl: 'https://api.openai.com/v1', protocol: 'responses' },
    { id: 'xai', name: NAMES.xai, label: S.xai, baseUrl: 'https://api.x.ai/v1', protocol: 'responses' },
    { id: 'opencode-go', name: NAMES['opencode-go'], label: S.go, baseUrl: '', protocol: 'chat-completions' },
    { id: 'custom', name: NAMES.custom, label: S.custom, baseUrl: '', protocol: 'responses' },
  ];
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const element = doc.createElement(tag); element.className = cls; element.textContent = text; return element;
  };
  const button = (text: string, action: string, primary = false) => {
    const element = h('button', `btn${primary ? ' primary' : ''}`, text); element.type = 'button'; element.dataset.action = action; return element;
  };
  const field = (label: string, input: HTMLElement) => { const el = h('label', 'home-connection-field'); el.append(h('span', 'fieldlabel', label), input); return el; };
  const section = h('section', 'sheet tabbed home-connections');
  section.append(h('h3', '', S.title));
  const body = h('div', 'sheetbody');
  const tabs = h('div', 'home-connection-services');
  tabs.setAttribute('aria-label', S.title);
  const serviceButtons = services.map((service) => {
    const el = button(service.label, service.id, service.id === 'chatgpt'); el.dataset.service = service.id;
    el.addEventListener('click', () => selectService(service), { signal }); tabs.append(el); return el;
  });
  const note = h('p', 'home-note');
  const status = h('span', 'pill plain'); status.dataset.role = 'account-status'; status.setAttribute('aria-live', 'polite');
  const account = h('span', 'home-connection-account');
  const accountRow = h('div', 'rowbar'); accountRow.append(status, account);
  const actions = h('div', 'rowbar');
  const login = button(S.login, 'login', true), cancel = button(S.cancel, 'cancel'), logout = button(S.logout, 'logout');
  const unavailableLogin = button(S.xaiLogin, 'xai-login'); unavailableLogin.disabled = true;
  const newAccount = button(S.newAccount, 'new-account'), enablePlan = button(S.enablePlan, 'enable-plan', true);
  actions.append(login, cancel, logout, newAccount, enablePlan, unavailableLogin);
  const savedAccounts = h('select', 'field'); savedAccounts.dataset.field = 'account';
  const switchAccount = button(S.switchAccount, 'switch-account');
  const accountPicker = h('div', 'home-connection-accountpicker'); accountPicker.append(field(S.savedAccounts, savedAccounts), switchAccount);
  const key = h('input', 'field'); key.type = 'password'; key.autocomplete = 'off'; key.dataset.field = 'key';
  const keyField = field(S.key, key);
  const base = h('input', 'field'); base.type = 'url'; base.placeholder = 'https://'; base.spellcheck = false; base.dataset.field = 'base';
  const protocol = h('select', 'field'); protocol.dataset.field = 'protocol';
  for (const [value, label] of [['responses', 'OpenAI Responses'], ['chat-completions', 'OpenAI Chat Completions'], ['anthropic-messages', 'Anthropic Messages']]) {
    const el = h('option', '', label); el.value = value!; protocol.append(el);
  }
  const customFields = h('div', 'home-connection-grid'); customFields.append(field(S.base, base), field(S.protocol, protocol));
  const save = button(S.save, 'save'), refresh = button(S.refresh, 'models');
  const keyActions = h('div', 'rowbar'); keyActions.append(save, refresh);
  const model = h('input', 'field'); model.autocomplete = 'off'; model.spellcheck = false; model.placeholder = S.selectModel; model.dataset.field = 'model';
  const modelList = h('datalist'); modelList.id = 'home-connection-models'; model.setAttribute('list', modelList.id);
  const modelSelect = h('select', 'field'); modelSelect.dataset.field = 'chatgpt-model';
  const modelField = field(S.model, model); modelField.append(modelSelect, modelList);
  const images = h('input'); images.type = 'checkbox'; images.dataset.field = 'images';
  const imageField = h('label', 'check home-connection-images'); imageField.append(images, doc.createTextNode(S.images));
  const activate = button(S.testActivate, 'activate', true);
  const testNote = h('p', 'home-note', S.testNote);
  const goUnavailable = button(S.goUnavailable, 'go-unavailable'); goUnavailable.disabled = true;
  const goLink = h('a', 'home-link', S.docs); goLink.href = 'https://opencode.ai/docs/go/'; goLink.target = '_blank'; goLink.rel = 'noopener noreferrer';
  const goDetails = h('div', 'home-connection-go'); goDetails.append(goUnavailable, goLink);
  const message = h('div', 'msgline'); message.dataset.role = 'connection-message'; message.setAttribute('aria-live', 'polite');
  body.append(tabs, note, accountRow, accountPicker, actions, customFields, keyField, keyActions, modelField, imageField, activate, testNote, goDetails, message);
  section.append(body); root.append(section);

  let selected = services[0]!;
  let state: AccountState = { status: 'signed-out' };
  let models: ConnectionModel[] = [];
  let detail: Detail | null = null;
  let generation = 0;
  let disposed = signal.aborted;
  let busy = false;
  let committing = false;
  let actionController: AbortController | null = null;
  let pollController: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let oauthName: string | null = null;
  const isCurrent = (version: number) => !disposed && !signal.aborted && version === generation;
  const request = <T>(path: string, body?: unknown, requestSignal?: AbortSignal) => call<T>(path, body, { signal: requestSignal });
  const panel = <T>(method: string, name: string, requestSignal?: AbortSignal, extra: { accountId?: string; newAccount?: boolean; enablePlanUsage?: boolean } = {}) => request<T>(ACCOUNT_PATH + method, { args: [{ name, ...extra }] }, requestSignal);
  const usableAccount = (value: AccountState) => value.status === 'connected' && value.authenticated !== false && value.planUsageEnabled !== false;
  const feedback = (text: string, bad = false) => { message.textContent = text; message.classList.toggle('bad', bad); };
  const stopPoll = () => { clearTimeout(pollTimer); pollTimer = undefined; pollController?.abort(); pollController = null; };
  // OAuth is host-owned. Aborting a renderer request is not cancellation: always call cancel.
  const cancelOwnedLogin = () => {
    const name = oauthName; oauthName = null;
    if (name) void call(ACCOUNT_PATH + 'cancel', { args: [{ name }] }, { keepalive: true }).catch(() => undefined);
  };
  const setModels = (values: ConnectionModel[]) => {
    models = values.filter((value) => value && typeof value.id === 'string' && value.id !== PENDING_MODEL);
    const chosen = modelSelect.value || detail?.entry.spec?.model || '';
    modelList.replaceChildren(...models.map((value) => { const el = h('option', '', value.displayName ?? value.id); el.value = value.id; return el; }));
    const empty = h('option', '', S.selectModel); empty.value = '';
    modelSelect.replaceChildren(empty, ...models.map((value) => { const el = h('option', '', value.displayName ?? value.id); el.value = value.id; return el; }));
    modelSelect.value = models.some((value) => value.id === chosen) ? chosen : '';
  };
  const render = () => {
    if (disposed) return;
    const chatgpt = selected.id === 'chatgpt', go = selected.id === 'opencode-go', custom = selected.id === 'custom';
    serviceButtons.forEach((el, index) => { const on = services[index] === selected; el.classList.toggle('on', on); el.setAttribute('aria-pressed', String(on)); el.disabled = committing; });
    note.textContent = chatgpt ? S.chatgptNote : go ? S.goNote : custom ? S.customNote : S.xaiNote;
    status.textContent = ({ 'signed-out': S.signedOut, authorizing: S.authorizing, connected: S.connected, expired: S.expired, error: S.error })[state.status];
    if (chatgpt && state.authenticated && state.planUsageEnabled === false) status.textContent = S.planDisabled;
    status.className = `pill ${state.status === 'connected' ? 'on' : state.status === 'error' || state.status === 'expired' ? 'off' : 'plain'}`;
    account.textContent = state.account ?? '';
    accountRow.hidden = go;
    login.hidden = !chatgpt || state.status === 'authorizing' || state.status === 'connected' || state.authenticated === true;
    newAccount.hidden = !chatgpt || state.status === 'authorizing';
    enablePlan.hidden = !chatgpt || !state.authenticated || state.planUsageEnabled !== false || state.status === 'authorizing';
    accountPicker.hidden = !chatgpt || !state.accounts?.length;
    cancel.hidden = !chatgpt || (state.status !== 'authorizing' && !oauthName);
    logout.hidden = !chatgpt || (!state.authenticated && !['connected', 'expired', 'error'].includes(state.status));
    unavailableLogin.hidden = selected.id !== 'xai';
    customFields.hidden = !custom;
    keyField.hidden = chatgpt || go; key.placeholder = detail ? S.keepKey : '';
    keyActions.hidden = go; save.hidden = chatgpt; refresh.hidden = chatgpt && !usableAccount(state);
    modelField.hidden = go; model.hidden = chatgpt; modelSelect.hidden = !chatgpt;
    imageField.hidden = !custom;
    activate.hidden = go; testNote.hidden = go; goDetails.hidden = !go;
    const authorizing = state.status === 'authorizing' || !!oauthName;
    section.setAttribute('aria-busy', String(busy || authorizing));
    for (const el of [login, logout, newAccount, enablePlan, switchAccount, savedAccounts, save, refresh, activate, key, base, protocol, model, modelSelect, images]) el.disabled = busy || authorizing;
    activate.disabled ||= chatgpt ? !usableAccount(state) || !modelSelect.value : !model.value.trim();
    refresh.disabled ||= !detail;
    switchAccount.disabled ||= !savedAccounts.value;
    modelSelect.disabled ||= !usableAccount(state);
    cancel.disabled = false;
  };
  const adoptState = (value: AccountState) => {
    state = value;
    const chosenAccount = savedAccounts.value;
    const emptyAccount = h('option', '', S.chooseAccount); emptyAccount.value = '';
    savedAccounts.replaceChildren(emptyAccount, ...(value.accounts ?? []).map((item) => {
      const el = h('option', '', item.label ?? item.email ?? item.id); el.value = item.id; return el;
    }));
    savedAccounts.value = (value.accounts ?? []).some((item) => item.id === chosenAccount) ? chosenAccount : '';
    if (value.status !== 'authorizing') oauthName = null;
    if (value.models) setModels(value.models);
    if (value.authenticated && value.planUsageEnabled === false) feedback(S.planDisabledNote);
    else if (value.message) feedback(value.message, value.status === 'error' || value.status === 'expired');
    render();
  };
  const loadModels = async (version: number, requestSignal: AbortSignal) => {
    const reply = await panel<ConnectionModel[] | { models: ConnectionModel[] }>('models', selected.name, requestSignal);
    if (isCurrent(version)) { setModels(Array.isArray(reply) ? reply : reply.models); render(); }
  };
  const schedulePoll = () => {
    clearTimeout(pollTimer); pollTimer = undefined;
    if (disposed || doc.hidden || busy || selected.id !== 'chatgpt' || state.status !== 'authorizing') return;
    pollTimer = setTimeout(() => { void poll(); }, 1500);
  };
  const poll = async () => {
    if (disposed || doc.hidden || busy || pollController || selected.id !== 'chatgpt' || state.status !== 'authorizing') return;
    const version = generation;
    const controller = new AbortController(); pollController = controller;
    try {
      const value = await panel<AccountState>('state', selected.name, controller.signal);
      if (!isCurrent(version) || controller.signal.aborted || doc.hidden) return;
      adoptState(value);
      if (usableAccount(value) && !value.models?.length) await loadModels(version, controller.signal);
    } catch (error) {
      if (isCurrent(version) && !controller.signal.aborted) feedback(errorText(error), true);
    } finally {
      if (pollController === controller) { pollController = null; schedulePoll(); }
    }
  };
  const read = async (version: number, requestSignal: AbortSignal) => {
    const list = await request<{ providers: Array<{ name: string }> }>('/api/providers', undefined, requestSignal);
    if (!isCurrent(version)) return;
    if (!list.providers.some((entry) => entry.name === selected.name)) { detail = null; adoptState({ status: 'signed-out' }); return; }
    const value = await request<Detail>(`/api/providers/${encodeURIComponent(selected.name)}`, undefined, requestSignal);
    if (!isCurrent(version)) return;
    if (value.entry.kind !== 'connections' || value.entry.options?.service !== selected.id) throw new Error(S.collision);
    detail = value;
    if (selected.id === 'custom') { base.value = value.entry.baseUrl; protocol.value = value.entry.options?.protocol ?? 'responses'; images.checked = value.entry.options?.inputImages === true; }
    model.value = value.entry.spec?.model === PENDING_MODEL ? '' : value.entry.spec?.model ?? '';
    const current = await panel<AccountState>('state', selected.name, requestSignal);
    if (!isCurrent(version)) return;
    adoptState(current);
    if (current.status === 'authorizing') oauthName = selected.name;
    if (usableAccount(current) && !current.models?.length) await loadModels(version, requestSignal);
  };
  const run = async (work: (version: number, requestSignal: AbortSignal) => Promise<void>) => {
    if (busy || disposed || selected.id === 'opencode-go') return;
    stopPoll(); busy = true; render();
    const version = ++generation, controller = new AbortController(); actionController = controller;
    try { await work(version, controller.signal); }
    catch (error) { if (isCurrent(version) && !controller.signal.aborted) feedback(errorText(error), true); }
    finally { if (isCurrent(version)) { busy = false; committing = false; actionController = null; render(); schedulePoll(); } }
  };
  const validBase = () => {
    const value = base.value.trim();
    try {
      const parsed = new URL(value);
      if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
      return value.replace(/\/+$/, '');
    } catch { throw new Error(S.invalidUrl); }
  };
  const saveEntry = async (version: number, requestSignal: AbortSignal, chosenModel?: string) => {
    const chatgpt = selected.id === 'chatgpt', secretValue = key.value.trim();
    if (!chatgpt && !secretValue && !detail) throw new Error(S.keyRequired);
    const id = selected.name;
    // Read the latest revision before every write, preserving unrelated supported entry settings.
    const list = await request<{ providers: Array<{ name: string }> }>('/api/providers', undefined, requestSignal);
    if (!isCurrent(version)) return false;
    const prior = list.providers.some((entry) => entry.name === id) ? await request<Detail>(`/api/providers/${encodeURIComponent(id)}`, undefined, requestSignal) : null;
    if (!isCurrent(version)) return false;
    if (prior && (prior.entry.kind !== 'connections' || prior.entry.options?.service !== selected.id)) throw new Error(S.collision);
    const modelName = chosenModel || prior?.entry.spec?.model || PENDING_MODEL;
    const catalogModel = models.find((value) => value.id === modelName);
    const imageInput = selected.id === 'custom' ? images.checked : catalogModel?.inputImages === true;
    const spec: NonNullable<ConnectionEntry['spec']> = { thinking: false, maxTokens: 8192, ...prior?.entry.spec, model: modelName };
    // Persist verified caps for the first request after restart, before a catalog can load.
    // A previous model's context limit is not evidence about a newly selected model.
    const contextWindow = catalogModel?.contextWindow;
    if (typeof contextWindow === 'number' && Number.isInteger(contextWindow) && contextWindow > 0) spec.contextWindow = contextWindow;
    else if (prior?.entry.spec?.model !== modelName) delete spec.contextWindow;
    const maxOutputTokens = catalogModel?.maxOutputTokens;
    if (typeof maxOutputTokens === 'number' && Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) {
      spec.maxTokens = Math.min(spec.maxTokens ?? 8192, maxOutputTokens);
    }
    const entry: ConnectionEntry = {
      ...prior?.entry, kind: 'connections', baseUrl: selected.id === 'custom' ? validBase() : selected.baseUrl,
      spec, multimodal: imageInput,
      options: { ...prior?.entry.options, service: selected.id, protocol: selected.id === 'custom' ? protocol.value : selected.protocol, inputImages: imageInput },
    };
    if (chatgpt) { delete entry.secret; delete entry.options!.inputImages; }
    else entry.secret = `CORTICO_KEY_${id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
    const payload = { name: id, entry, ...(secretValue && !chatgpt ? { secretValue } : {}), ...(prior ? { expectedRevision: prior.revision } : {}) };
    const saved = await request<Detail>(prior ? `/api/providers/${encodeURIComponent(id)}/save` : '/api/providers', payload, requestSignal);
    if (!isCurrent(version)) return false;
    detail = saved; key.value = ''; return true;
  };
  async function selectService(service: Service) {
    if (disposed || committing || service === selected) return;
    ++generation; actionController?.abort(); actionController = null; stopPoll(); cancelOwnedLogin();
    selected = service; busy = false; detail = null; state = { status: 'signed-out' }; models = [];
    key.value = ''; model.value = ''; base.value = ''; protocol.value = service.protocol; images.checked = false;
    savedAccounts.replaceChildren(); setModels([]); feedback(''); render();
    if (selected.id !== 'opencode-go') await run(read);
  }
  const startLogin = (input: { accountId?: string; newAccount?: boolean; enablePlanUsage?: boolean } = {}) => run(async (version, requestSignal) => {
    feedback(S.working);
    if (!await saveEntry(version, requestSignal) || !isCurrent(version)) return;
    oauthName = selected.name; render();
    // Keep the login response observable after unmount so a late host start is also canceled.
    const name = selected.name;
    const value = await panel<AccountState>('login', name, undefined, input);
    if (!isCurrent(version)) {
      if (value.status === 'authorizing') void call(ACCOUNT_PATH + 'cancel', { args: [{ name }] }, { keepalive: true }).catch(() => undefined);
      return;
    }
    adoptState(value);
    if (usableAccount(value)) await loadModels(version, requestSignal);
  });
  login.addEventListener('click', () => { void startLogin(); }, { signal });
  newAccount.addEventListener('click', () => { void startLogin({ newAccount: true }); }, { signal });
  enablePlan.addEventListener('click', () => {
    if (state.authenticated && state.planUsageEnabled === false) void startLogin({ enablePlanUsage: true });
  }, { signal });
  switchAccount.addEventListener('click', () => { if (savedAccounts.value) void startLogin({ accountId: savedAccounts.value }); }, { signal });
  savedAccounts.addEventListener('change', render, { signal });
  cancel.addEventListener('click', () => {
    if (disposed) return;
    ++generation; actionController?.abort(); actionController = null; stopPoll(); busy = false;
    const name = oauthName ?? selected.name; oauthName = name;
    void run(async (version, requestSignal) => { const value = await panel<AccountState>('cancel', name, requestSignal); if (isCurrent(version)) { adoptState(value); feedback(S.canceled); } });
  }, { signal });
  logout.addEventListener('click', () => { void run(async (version, requestSignal) => {
    const value = await panel<AccountState>('logout', selected.name, requestSignal);
    if (isCurrent(version)) { setModels([]); adoptState(value); feedback(value.message ?? ''); }
  }); }, { signal });
  save.addEventListener('click', () => { void run(async (version, requestSignal) => {
    feedback(S.working);
    if (!await saveEntry(version, requestSignal) || !isCurrent(version)) return;
    const value = await panel<AccountState>('state', selected.name, requestSignal);
    if (!isCurrent(version)) return;
    adoptState(value); feedback(S.saved);
    await loadModels(version, requestSignal);
  }); }, { signal });
  refresh.addEventListener('click', () => { void run(async (version, requestSignal) => { feedback(''); await loadModels(version, requestSignal); }); }, { signal });
  activate.addEventListener('click', () => { void run(async (version, requestSignal) => {
    const chosen = (selected.id === 'chatgpt' ? modelSelect.value : model.value).trim();
    if (!chosen || chosen === PENDING_MODEL) throw new Error(S.noModel);
    if (selected.id === 'chatgpt' && !usableAccount(state)) throw new Error(S.signInRequired);
    feedback(S.testing);
    if (!await saveEntry(version, requestSignal, chosen) || !isCurrent(version)) return;
    const path = `/api/providers/${encodeURIComponent(selected.name)}`;
    const result = await request<{ ok?: boolean; error?: string; hint?: string }>(path + '/test', {}, requestSignal);
    if (!isCurrent(version)) return;
    // Fail closed: absent/ambiguous receipts are never successful tests.
    if (result?.ok !== true || result.error) throw new Error(result?.hint || result?.error || S.failedTest);
    committing = true; render();
    await request(path + '/activate', {}, requestSignal);
    if (!isCurrent(version)) return;
    await request('/api/run/resume', {}, requestSignal);
    if (!isCurrent(version)) return;
    feedback(S.started); await options.onActivated?.();
  }); }, { signal });
  for (const control of [model, modelSelect, images, base, protocol]) control.addEventListener('input', () => { feedback(''); render(); }, { signal });
  const visibility = () => { if (doc.hidden) stopPoll(); else { void poll(); schedulePoll(); } };
  doc.addEventListener('visibilitychange', visibility, { signal });
  const dispose = () => {
    if (disposed) return;
    disposed = true; ++generation; actionController?.abort(); stopPoll(); cancelOwnedLogin(); key.value = '';
    doc.removeEventListener('visibilitychange', visibility);
  };
  signal.addEventListener('abort', dispose, { once: true });
  render();
  if (!disposed) void run(read);
  return { dispose, refresh: () => run(read) };
}
