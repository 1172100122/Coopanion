/**
 * The app's Core process: Cormini as the Persona, the terminal, desktop-pet and cua Worlds, Coo Pet
 * Provider (DeepSeek and the other model services Coo offers) next to Cortico's built-in providers,
 * and Worlds or providers installed from npm through the console's extension page.
 *
 * The two bundled Worlds are wired to each other and to the app: the header of the pet's right-click
 * menu pauses and resumes the run, opens the settings window and quits the app, as the console's rail
 * foot does; computer use
 * asks for permission in the pet's bubble, and falls back to its own system dialog while no
 * pet page is connected.
 *
 * First start writes the files in `seed.ts`; after that every value is the operator's, edited in
 * the console. While the active endpoint has no key, event delivery starts paused. The first start
 * runs the introduction (`guide.ts`) in the pet's bubble, the key box included; after it, the pet
 * asks for a missing key in its bubble now and then, for as long as no key is set. An introduction
 * walked through to the end tells Coo so in an internal event (`guideFinished`): the persona, the
 * names and the rest are now its to settle with the person, and the prompt page is where both of
 * them edit it.
 *
 * The parent (Electron main) gets `{ type: 'companion:ready', port, dataDir, keyMissing }` once the
 * console listens, `{ type: 'companion:open', path }` to show the settings window at a console
 * route, `{ type: 'companion:hide' }` to put it away (the introduction runs again on the desktop)
 * and `{ type: 'companion:quit' }` to quit the whole app; it asks for a clean stop with
 * `{ type: 'companion:shutdown' }`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BotDefinition } from 'cortico/bot.ts';
import { createBot } from 'cortico/bot.ts';
import { announceDataDir, consumeBootFlags } from 'cortico/boot.ts';
import type { WakeBus } from 'cortico/core/bus.ts';
import { secretReader } from 'cortico/core/secrets.ts';
import type { CoreConfig } from 'cortico/core/types.ts';
import { loadDeployment } from 'cortico/deploy.ts';
import { loadExtensions } from 'cortico/extensions.ts';
import { deploymentRoot, providersRoot, repoRoot } from 'cortico/paths.ts';
import { providerModules, registerProviderModules } from 'cortico/providers/registry.ts';
import { withWorlds, type WorldDefinition, type WorldSection } from 'cortico/world.ts';
import { TERMINAL } from 'cortico/worlds/terminal/definition.ts';
import { desktopPetDefinition, type DesktopPetWorld } from 'cortico-world-desktop-pet';
import { cuaDefinition } from 'cortico-world-cua';
import COO from 'cortico-provider-coo';
import { bundledConsoleAssets } from './bundled-panels.ts';
import { askForKey, guideDone, markDone, runGuide, type GuideDeps } from './guide.ts';
import { CONSOLE_PORT, DEPLOYMENT, DISPLAY_NAME, seed } from './seed.ts';

/** The active endpoint's key is set in the process environment or the endpoint's `.env`. */
function hasKey(config: CoreConfig): boolean {
  const entry = config.providers[config.activeProvider];
  if (!entry) return false;
  if (!entry.secret) return true;
  return secretReader(join(providersRoot(), config.activeProvider, '.env'))(entry.secret) !== '';
}

/** How long the pet page gets to show up on a first start before the settings window opens instead. */
const PET_WAIT_MS = 60_000;
/** Pet events that mean the person is talking to Coo. */
const TALK_EVENTS = new Set(['desktop-pet.message', 'desktop-pet.speech']);
/** After an introduction where the key was put off, the first ask waits this long (talking to Coo asks sooner). */
const ASK_AFTER_GUIDE_MS = 20 * 60_000;
/** Written in the deployment directory once the introduction has run. */
const GUIDE_FILE = 'guide.json';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GUIDE_FINISHED = (name: string) => [
  `[启动引导] ${name}刚在你的气泡里走完了启动引导:定了你怎么称呼对方(「${name}」)、你平时活泼到什么程度、用哪家模型服务,也看过了怎么语音输入、按钮和菜单在哪。`,
  `接下来可以和${name}商量你们之间的设定:你的性格和说话方式、你怎么称呼对方、对方想怎么叫你、希望你平时做什么不做什么。`,
  '- 你的人设是工作区里的 CONSTITUTION.md,每次开新 session 都放进你的系统前缀。商量出结果后你可以自己改它,下一次 session 生效。',
  '- 对方的称呼是设置窗口「习惯」页的「怎么称呼你」,由对方自己改;商量好的称呼和其他偏好可以记进你的工作区。',
  '- 设置窗口的「系统提示词」页能看到并编辑你的整份系统提示词,CONSTITUTION 也在里面。可以引导对方去那里按自己的喜好改;对方想改什么,你也可以替对方改。',
  '不用一次说完,看对方的兴致。',
].join('\n');

/** Tells Coo the introduction was walked through; delivered with the next batch (after the key is set, while events are held without one). */
function guideFinished(bus: WakeBus, name: string): void {
  bus.push({ deferred: { type: 'companion.guide-finished', source: 'companion', origin: 'internal', render: () => GUIDE_FINISHED(name) } });
}

/** Notes the person talking to Coo on the bus; the returned check reports it once and resets. */
function watchTalk(bus: WakeBus): () => boolean {
  let heard = false;
  const push = bus.push.bind(bus);
  bus.push = (item, opts) => {
    if (item.event && TALK_EVENTS.has(item.event.type)) heard = true;
    push(item, opts);
  };
  return () => { const was = heard; heard = false; return was; };
}

/**
 * The introduction on a first start, then the key asks while no key is set. An install that already
 * has a key (one from before the introduction existed) counts as introduced. When no pet page shows
 * up on a first start, the settings window opens at the home page instead, since nothing else would
 * tell the person why Coo stays silent.
 */
async function introduce(deps: GuideDeps, keySet: () => boolean, talked: (() => boolean) | null): Promise<void> {
  const first = !guideDone(deps.doneFile);
  if (first && keySet()) { markDone(deps.doneFile); return; }
  if (first) {
    const deadline = Date.now() + PET_WAIT_MS;
    while (!deps.pet()?.petState().connected && Date.now() < deadline) await sleep(1000);
    if (!deps.pet()?.petState().connected) process.send?.({ type: 'companion:open', path: '#/home' });
    await runGuide(deps);
  }
  if (!talked) return;
  // the introduction just asked for the key and the person put it off: the next ask waits
  await askForKey(deps, keySet, talked, first ? ASK_AFTER_GUIDE_MS : 0);
}

async function corminiDefinition(): Promise<BotDefinition<CoreConfig>> {
  const file = join(repoRoot(), 'bots', 'cormini', 'index.ts');
  return (await import(pathToFileURL(file).href) as { default: BotDefinition<CoreConfig> }).default;
}

export async function main(): Promise<void> {
  let pet: DesktopPetWorld | null = null;
  /** Set once the bot exists; the pet's menu reads it only after the pet page connects. */
  let bus: WakeBus | null = null;
  /** Set once the console listens. */
  let guide: GuideDeps | null = null;
  const DESKTOP_PET = desktopPetDefinition({
    // the menu's header lends pause/resume, settings and quit; its dress tile opens the settings window's dress page
    controls: {
      isPaused: () => bus?.isPaused() ?? false,
      setPaused: (paused) => bus?.setPaused(paused),
      openSettings: () => process.send?.({ type: 'companion:open', path: '' }),
      openDress: () => process.send?.({ type: 'companion:open', path: '#/dress' }),
      quit: () => process.send?.({ type: 'companion:quit' }),
      quitLabel: '退出应用',
      guide: () => {
        if (!guide) return;
        process.send?.({ type: 'companion:hide' });
        void runGuide(guide);
      },
    },
    onCreate: (world) => { pet = world; },
  });
  const CUA = cuaDefinition({
    askPermission: async (question) => {
      const answer = await pet?.confirm(question, ['可以', '这次不行']) ?? 'unavailable';
      return answer === 'unavailable' ? null : answer === 'yes' || answer === 'timeout' ? answer : 'no';
    },
  });
  const home = deploymentRoot();
  seed(home);
  const cormini = await corminiDefinition();
  const base: BotDefinition<CoreConfig> = {
    ...cormini,
    declares: [TERMINAL.id, DESKTOP_PET.id, CUA.id],
    defaults: () => ({ ...cormini.defaults(), displayName: DISPLAY_NAME, web: { port: CONSOLE_PORT, theme: 'mint' } }),
  };
  const bundled = [TERMINAL, DESKTOP_PET, CUA] as WorldDefinition<WorldSection>[];

  // extension providers must be registered before endpoints are resolved
  const extensions = await loadExtensions(repoRoot(), {
    reserved: bundled.map((w) => w.id),
    reservedProviders: [...providerModules.map((m) => m.id), COO.id],
  });
  registerProviderModules([COO, ...extensions.providers]);
  extensions.consoleAssets.push(...bundledConsoleAssets([
    { id: DESKTOP_PET.id, packageName: 'cortico-world-desktop-pet' },
    { id: CUA.id, packageName: 'cortico-world-cua' },
  ]));
  const definition = withWorlds(base, [...bundled, ...extensions.worlds]);

  const deployDir = join(home, DEPLOYMENT);
  const loaded = loadDeployment(definition, deployDir, repoRoot(), join(repoRoot(), 'bots', 'cormini'), providersRoot());
  announceDataDir(loaded.dataDir);
  consumeBootFlags(loaded.dataDir);

  const bot = createBot(loaded, definition, { extensions });
  bus = bot.core.bus;
  // without a key every model call fails: hold events until the home page saves one and resumes
  const keyMissing = !hasKey(loaded.config);
  if (keyMissing) bot.core.bus.setPaused(true);
  const { port } = await bot.start();
  process.send?.({ type: 'companion:ready', port, dataDir: loaded.dataDir, keyMissing });
  const guideDeps: GuideDeps = {
    pet: () => pet,
    console: `http://127.0.0.1:${port}`,
    doneFile: join(deployDir, GUIDE_FILE),
    openDress: () => process.send?.({ type: 'companion:open', path: '#/dress' }),
    onFinish: (name) => guideFinished(bot.core.bus, name),
  };
  guide = guideDeps;
  void introduce(guideDeps, () => hasKey(loaded.config), keyMissing ? watchTalk(bot.core.bus) : null).catch((err) => {
    bot.core.runlog.logger('process').emit('error', '引导出错', { event: 'guide-error', err });
  });

  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    const done = await Promise.race([bot.shutdown(reason).then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 30_000))]);
    process.exit(done ? 0 : 1);
  };
  process.on('message', (msg: { type?: string }) => { if (msg?.type === 'companion:shutdown') void shutdown('应用退出'); });
  process.on('disconnect', () => void shutdown('应用进程已退出'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  const log = bot.core.runlog.logger('process');
  process.on('uncaughtException', (err) => {
    log.emit('error', '未捕获异常,正在关机', { event: 'uncaught-exception', err });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.emit('error', '未处理的 promise 拒绝', { event: 'unhandled-rejection', err: reason });
  });
}
