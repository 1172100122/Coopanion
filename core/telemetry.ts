/**
 * Anonymous usage statistics, sent to the project's own server (`telemetry-server/`). Every field
 * is listed in docs/TELEMETRY.md; nothing the person says, types, sees or names leaves the machine,
 * and neither do keys, file names, endpoint addresses or the names of models on custom endpoints.
 *
 * An install is a random id made on the first start (`telemetry.json` in the deployment directory),
 * tied to nothing else. The day's counts and a snapshot of the settings go out as one record per
 * local date, sent again every `SEND_MS` while the app runs (the server keeps the latest);
 * one-off events (first start, onboarding steps, the source answer, extensions added or removed, a
 * crash) queue in the same file until a send gets through, so a start without network loses
 * nothing. Switched off in the 「习惯」 page (`companion.telemetry`): one last `telemetry_disabled`
 * is sent, the queue is dropped, and nothing is counted until it is switched on again.
 *
 * `telemetry-id` next to the state file holds the id while statistics are on: the Windows
 * uninstaller reads it to report the uninstall (installer/nsis.nsh).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';

export const TELEMETRY_URL = 'https://survey.palailab.org/v1/report';
/** How often the day's record goes out while the app runs. */
const SEND_MS = 30 * 60_000;
/** Running time is counted in whole minutes. */
const TICK_MS = 60_000;
/** A tick longer than this (the machine slept) counts as one minute. */
const TICK_GAP_MS = 3 * TICK_MS;
/** One-off events kept while sends fail; the oldest go first past it. */
const QUEUE_MAX = 300;
const SEND_TIMEOUT_MS = 15_000;
const STATE_FILE = 'telemetry.json';
const ID_FILE = 'telemetry-id';

export const COUNTERS = [
  'sessions', 'messagesText', 'messagesVoice', 'touches', 'answers', 'petReplies',
  'cuaActions', 'cuaAsked', 'cuaGranted', 'providerErrors',
] as const;
export type Counter = typeof COUNTERS[number];

export interface ModelUse {
  vendor: string;
  /** The model name for a built-in service; `custom` on any other endpoint. */
  model: string;
  endpointKind: 'builtin' | 'custom-remote' | 'custom-local';
  calls: number;
  failed: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
}

export interface TelemetryEvent { type: string; ts: string; [field: string]: unknown }

interface Day {
  date: string;
  runningMinutes: number;
  /** Minutes of the day (0–1439) with something the person did. */
  minutes: number[];
  counts: Record<Counter, number>;
  models: Record<string, ModelUse>;
  /** Filled in when the day is closed or sent. */
  snapshot?: Record<string, unknown>;
}

interface State {
  installId: string;
  firstDate: string;
  /** Local dates with at least one message to Coo, counted once each. */
  chatDays: number;
  lastChatDate: string | null;
  enabled: boolean;
  extensions: string[];
  day: Day;
  /** Closed days not sent yet. */
  days: Day[];
  queue: TelemetryEvent[];
}

export interface TelemetryOptions {
  /** The deployment directory. */
  dir: string;
  version: string;
  enabled: () => boolean;
  /** Settings and other state read at send time (docs/TELEMETRY.md, `snapshot`). */
  snapshot: () => Record<string, unknown>;
  /** The installed extensions as they should be reported, `name` or `private`, once per package. */
  extensions: () => Array<{ name: string; version: string | null; kind: string | null }>;
  url?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const emptyCounts = () => Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<Counter, number>;
const newDay = (date: string): Day => ({ date, runningMinutes: 0, minutes: [], counts: emptyCounts(), models: {} });

export class Telemetry {
  private state: State;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private timers: NodeJS.Timeout[] = [];
  private lastTick: number;
  private sending: Promise<void> | null = null;

  constructor(private readonly opts: TelemetryOptions) {
    this.url = opts.url ?? TELEMETRY_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.lastTick = this.now().getTime();
    const file = join(opts.dir, STATE_FILE);
    const today = localDate(this.now());
    if (existsSync(file)) {
      this.state = JSON.parse(readFileSync(file, 'utf8')) as State;
    } else {
      this.state = {
        installId: randomUUID(), firstDate: today, chatDays: 0, lastChatDate: null, enabled: opts.enabled(),
        extensions: [], day: newDay(today), days: [], queue: [],
      };
      this.event('first_launch', {});
    }
  }

  get installId(): string { return this.state.installId; }

  /** Counts this start, notes extension changes, then sends now and every `SEND_MS`. */
  start(): void {
    this.syncEnabled();
    if (this.state.enabled) {
      this.count('sessions');
      this.diffExtensions();
    }
    this.save();
    this.timers.push(setInterval(() => this.tick(), TICK_MS), setInterval(() => void this.send(), SEND_MS));
    for (const t of this.timers) t.unref();
    void this.send();
  }

  /** Stops the timers and makes one last send, bounded by `SEND_TIMEOUT_MS`. */
  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.tick();
    await this.send();
  }

  count(name: Counter, by = 1): void {
    if (!this.on()) return;
    this.rollDay();
    this.state.day.counts[name] += by;
  }

  /** The person did something with Coo: this minute counts as active; a message also makes the day a chat day. */
  interacted(chat: boolean): void {
    if (!this.on()) return;
    this.rollDay();
    const now = this.now();
    const minute = now.getHours() * 60 + now.getMinutes();
    if (!this.state.day.minutes.includes(minute)) this.state.day.minutes.push(minute);
    if (chat && this.state.lastChatDate !== this.state.day.date) {
      this.state.lastChatDate = this.state.day.date;
      this.state.chatDays += 1;
    }
  }

  /** One model call; `model` is already `custom` for an endpoint that is not a built-in service. */
  usage(use: Omit<ModelUse, 'calls' | 'failed' | 'tokensIn' | 'tokensOut' | 'tokensCached'>, rec: { promptTokens: number; completionTokens: number; cacheHitTokens: number; failed: boolean }): void {
    if (!this.on()) return;
    this.rollDay();
    const key = `${use.vendor}\u0000${use.model}\u0000${use.endpointKind}`;
    const m = this.state.day.models[key] ??= { ...use, calls: 0, failed: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0 };
    m.calls += 1;
    if (rec.failed) { m.failed += 1; this.state.day.counts.providerErrors += 1; }
    m.tokensIn += rec.promptTokens;
    m.tokensOut += rec.completionTokens;
    m.tokensCached += rec.cacheHitTokens;
  }

  /** A one-off event; queued until a send gets through. */
  event(type: string, fields: Record<string, unknown>): void {
    if (!this.on()) return;
    const queue = this.state.queue;
    queue.push({ type, ts: this.now().toISOString(), ...fields });
    if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  }

  private on(): boolean {
    this.syncEnabled();
    return this.state.enabled;
  }

  /** Follows the setting: switched off sends one `telemetry_disabled` and drops what was waiting. */
  private syncEnabled(): void {
    const enabled = this.opts.enabled();
    if (enabled === this.state.enabled) return;
    this.state.enabled = enabled;
    const today = localDate(this.now());
    if (!enabled) {
      this.state.queue = [{ type: 'telemetry_disabled', ts: this.now().toISOString() }];
      this.state.days = [];
      this.state.day = newDay(today);
    } else {
      this.state.day = newDay(today);
      this.event('telemetry_enabled', {});
    }
    this.save();
    // after the current call returns: syncEnabled also runs inside a send
    setTimeout(() => void this.send(), 0).unref();
  }

  private tick(): void {
    const now = this.now().getTime();
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    if (!this.on()) return;
    this.rollDay();
    this.state.day.runningMinutes += elapsed > TICK_GAP_MS ? 1 : Math.round(elapsed / TICK_MS);
    this.save();
  }

  private rollDay(): void {
    const today = localDate(this.now());
    if (this.state.day.date === today) return;
    this.state.day.snapshot = this.snapshot();
    this.state.days.push(this.state.day);
    this.state.day = newDay(today);
  }

  private diffExtensions(): void {
    const now = this.opts.extensions();
    const names = now.map((e) => e.name);
    const before = new Set(this.state.extensions);
    for (const e of now) if (!before.has(e.name)) this.event('extension_installed', { name: e.name, version: e.version, kind: e.kind });
    for (const name of this.state.extensions) if (!names.includes(name)) this.event('extension_removed', { name });
    this.state.extensions = [...new Set(names)];
  }

  private snapshot(): Record<string, unknown> {
    let fields: Record<string, unknown> = {};
    try { fields = this.opts.snapshot(); } catch { /* a setting that cannot be read is left out */ }
    return {
      ...fields,
      extensions: this.opts.extensions(),
      chatDays: this.state.chatDays,
      ramGB: Math.round(totalmem() / 2 ** 30),
      cpuCores: cpus().length,
    };
  }

  private dayRecord(day: Day): Record<string, unknown> {
    return {
      date: day.date,
      runningMinutes: day.runningMinutes,
      interactedMinutes: day.minutes.length,
      ...day.counts,
      models: Object.values(day.models),
      ...(day.snapshot ?? this.snapshot()),
    };
  }

  private save(): void {
    try {
      writeFileSync(join(this.opts.dir, STATE_FILE), JSON.stringify(this.state) + '\n');
      const idFile = join(this.opts.dir, ID_FILE);
      if (this.state.enabled) writeFileSync(idFile, this.state.installId);
      else rmSync(idFile, { force: true });
    } catch { /* read-only data dir: counts live in memory for this run */ }
  }

  /** Sends what is waiting and today's record; on failure everything stays for the next send. */
  send(): Promise<void> {
    this.sending ??= this.sendOnce().finally(() => { this.sending = null; });
    return this.sending;
  }

  private async sendOnce(): Promise<void> {
    this.syncEnabled();
    const enabled = this.state.enabled;
    if (enabled) this.rollDay();
    const queue = [...this.state.queue];
    const days = enabled ? [...this.state.days, this.state.day] : [];
    if (!queue.length && !days.length) return;
    const now = this.now();
    const body = {
      installId: this.state.installId,
      version: this.opts.version,
      os: process.platform,
      osRelease: release(),
      arch: process.arch,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      firstDate: this.state.firstDate,
      sentAt: now.toISOString(),
      events: queue,
      days: days.map((d) => this.dayRecord(d)),
    };
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    // what was queued meanwhile stays; closed days that went out are done
    this.state.queue.splice(0, queue.length);
    const sent = new Set(days.map((d) => d.date));
    this.state.days = this.state.days.filter((d) => !sent.has(d.date));
    this.save();
  }
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.0\.0\.0|.*\.local$)/i;

/** How an endpoint is reported: a built-in service by its id and model, anything else without its address or model name. */
export function describeEndpoint(entry: { kind: string; baseUrl?: string } | undefined, model: string, vendorOf: (baseUrl: string | undefined) => { id: string } | null): Omit<ModelUse, 'calls' | 'failed' | 'tokensIn' | 'tokensOut' | 'tokensCached'> {
  const vendor = vendorOf(entry?.baseUrl);
  if (vendor) return { vendor: vendor.id, model, endpointKind: 'builtin' };
  let host = '';
  try { host = entry?.baseUrl ? new URL(entry.baseUrl).hostname : ''; } catch { /* not a URL */ }
  return { vendor: `kind:${entry?.kind ?? 'unknown'}`, model: 'custom', endpointKind: host && PRIVATE_HOST.test(host) ? 'custom-local' : 'custom-remote' };
}

/** An extension's spec as written in extensions/package.json: a registry range keeps its name, a path or URL does not. */
export function publicExtensionName(name: string, spec: string): string {
  return /^(link:|file:|git|https?:|github:|\.|\/|[a-zA-Z]:\\)/.test(spec) ? 'private' : name;
}
