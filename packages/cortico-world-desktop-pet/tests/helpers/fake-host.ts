/** World 测试共用的 fake host:记录推送的事件与唤醒口径,其余宿主接口都是空实现。 */
import type { EventEnvelope, WorldHost, PushOptions } from 'cortico/core/types.ts';

export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  pushDeferred(): void {}
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    emit() {},
  } as unknown as WorldHost['log'];

  /** 与 events 逐条对齐:唤醒/攒批的口径也要能断言 */
  pushOpts: Array<PushOptions | undefined> = [];
  /** 与 events 逐条对齐:事件开头的本地时间前缀;events 里的 text 去掉了它,断言只看正文 */
  stamps: string[] = [];

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, opts?: PushOptions): Promise<EventEnvelope> {
    const stamp = /^\[[^\]]*\d\d:\d\d\] /.exec(e.text)?.[0] ?? '';
    this.stamps.push(stamp);
    const full = { ...e, text: e.text.slice(stamp.length), cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  notes: string[] = [];
  reportUsage(): void {}
}
