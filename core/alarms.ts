/**
 * Wake-ups Coo sets for itself (`alarm_set`, `alarm_list`, `alarm_cancel` of the `coopanion` World).
 * Nothing in the app shows them: when one is due Coo gets an internal event and is woken, as if it
 * had remembered on its own. They are kept in `alarms.json` in the deployment directory, so they
 * outlive a restart; one that fell due while the app was closed is delivered at the next start,
 * saying when it was meant for. A daily one is then set for its next day.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ToolDef } from 'cortico/core/types.ts';

export interface Alarm {
  id: string;
  /** When it is due, epoch ms. */
  at: number;
  note: string;
  daily: boolean;
  /** When it was set, epoch ms. */
  setAt: number;
}

interface Saved { next: number; alarms: Alarm[] }

const DAY_MS = 86_400_000;
/** A due alarm this much past its time was missed while the app was closed (the World looks every second). */
const MISSED_AFTER_MS = 60_000;

/** UTC minus local, in minutes, for `timezone` at `d`. */
function offsetMinutes(timezone: string, d: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return (d.getTime() - d.getMilliseconds() - local) / 60_000;
}

/** Epoch ms of a wall-clock time in `timezone`. */
export function localToEpoch(timezone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess + offsetMinutes(timezone, new Date(guess)) * 60_000;
  // across a daylight-saving change the offset at the result can differ from the guess's
  return guess + offsetMinutes(timezone, new Date(first)) * 60_000;
}

/** `MM-DD HH:MM` in `timezone`. */
export function localLabel(timezone: string, ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * When an alarm asked for as `at` (`HH:MM`, the next such time; or `YYYY-MM-DD HH:MM`) or
 * `inMinutes` is due, or why it cannot be set.
 */
export function dueTime(timezone: string, now: number, at: unknown, inMinutes: unknown): number | string {
  if (typeof inMinutes === 'number') {
    if (!(inMinutes >= 1)) return 'in_minutes 至少是 1';
    return now + Math.round(inMinutes * 60_000);
  }
  if (typeof at !== 'string') return '要给 at 或 in_minutes';
  const full = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(at.trim());
  if (full) {
    const ms = localToEpoch(timezone, +full[1]!, +full[2]!, +full[3]!, +full[4]!, +full[5]!);
    return ms > now ? ms : `${at} 已经过去了`;
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!clock || +clock[1]! > 23 || +clock[2]! > 59) return `at 应为 HH:MM 或 YYYY-MM-DD HH:MM,收到 ${JSON.stringify(at)}`;
  const today = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const ms = localToEpoch(timezone, +today.year!, +today.month!, +today.day!, +clock[1]!, +clock[2]!);
  return ms > now ? ms : ms + DAY_MS;
}

export class Alarms {
  private saved: Saved;

  constructor(private readonly file: string, private readonly timezone: string) {
    this.saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Saved : { next: 1, alarms: [] };
  }

  private save(): void {
    writeFileSync(this.file, `${JSON.stringify(this.saved, null, 2)}\n`);
  }

  /** Takes the alarms due at `now` off the list (a daily one is set again for its next day), each with whether it was missed. */
  takeDue(now: number): Array<{ alarm: Alarm; missed: boolean }> {
    const due = this.saved.alarms.filter((a) => a.at <= now);
    if (!due.length) return [];
    this.saved.alarms = this.saved.alarms.filter((a) => a.at > now);
    for (const a of due) {
      if (!a.daily) continue;
      let at = a.at;
      while (at <= now) at += DAY_MS;
      this.saved.alarms.push({ ...a, at });
    }
    this.save();
    return due.map((alarm) => ({ alarm, missed: now - alarm.at > MISSED_AFTER_MS }));
  }

  dueText(alarm: Alarm, missed: boolean): string {
    const when = localLabel(this.timezone, alarm.at);
    return [
      `[唤醒器] 你在 ${localLabel(this.timezone, alarm.setAt)} 设的唤醒到了(${alarm.id}${alarm.daily ? ',每天' : ''}):${alarm.note}`,
      ...(missed ? [`原定 ${when},那时应用没开着,现在才送到。`] : []),
    ].join('\n');
  }

  tools(now: () => number = Date.now): ToolDef[] {
    const tz = this.timezone;
    const list = () => this.saved.alarms.slice().sort((a, b) => a.at - b.at)
      .map((a) => `- ${a.id}:${localLabel(tz, a.at)}${a.daily ? '(每天)' : ''} ${a.note}`).join('\n');
    return [
      {
        name: 'alarm_set',
        tags: ['write'],
        description: '给自己设一个唤醒器:到点时你会被叫醒,收到一条 [唤醒器] 事件,里面原样带着 note。对方看不到唤醒器。用来按时提醒对方、到点做某件事,或者过一阵回来看看。应用关着时到点的,下次启动时送到并注明原定时间。',
        parameters: {
          type: 'object',
          properties: {
            at: { type: 'string', description: '对方的本地时间:HH:MM(今天已过就是明天),或 YYYY-MM-DD HH:MM。和 in_minutes 二选一。' },
            in_minutes: { type: 'number', minimum: 1, description: '从现在起多少分钟后。' },
            note: { type: 'string', description: '到点时要做什么、为什么设它,写给到时候的你看。' },
            daily: { type: 'boolean', description: 'true 每天这个时间都叫醒你,直到 alarm_cancel。' },
          },
          required: ['note'],
        },
        handler: async (args) => {
          const note = typeof args.note === 'string' ? args.note.trim() : '';
          if (!note) return { text: '[alarm_set 没执行] note 不能为空。', failed: true };
          const t = now();
          const at = dueTime(tz, t, args.at, args.in_minutes);
          if (typeof at === 'string') return { text: `[alarm_set 没执行] ${at}。`, failed: true };
          const alarm: Alarm = { id: `a${this.saved.next++}`, at, note, daily: args.daily === true, setAt: t };
          this.saved.alarms.push(alarm);
          this.save();
          return { text: `已设 ${alarm.id}:${localLabel(tz, at)}${alarm.daily ? ',之后每天这个时间' : ''}。` };
        },
      },
      {
        name: 'alarm_list',
        tags: ['read'],
        description: '列出你设着的唤醒器:编号、时间(对方的本地时间)、note。',
        parameters: { type: 'object', properties: {} },
        handler: async () => ({ text: this.saved.alarms.length ? list() : '没有设着的唤醒器。' }),
      },
      {
        name: 'alarm_cancel',
        tags: ['write'],
        description: '取消一个唤醒器,每天的也一并停掉。',
        parameters: { type: 'object', properties: { id: { type: 'string', description: 'alarm_set 回执或 alarm_list 里的编号,如 a3。' } }, required: ['id'] },
        handler: async (args) => {
          const before = this.saved.alarms.length;
          this.saved.alarms = this.saved.alarms.filter((a) => a.id !== args.id);
          if (this.saved.alarms.length === before) return { text: `[alarm_cancel 没执行] 没有 ${JSON.stringify(args.id)} 这个唤醒器。`, failed: true };
          this.save();
          return { text: `已取消 ${args.id}。` };
        },
      },
    ];
  }
}
