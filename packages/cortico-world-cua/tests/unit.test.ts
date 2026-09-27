import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { parseKeys } from '../src/engine/keys.ts';
import { appleString, dialogAnswer, macKey, unicodeChunks } from '../src/engine/mac-keys.ts';
import { downscale, drawCursor, encodeJpeg, fit } from '../src/engine/image.ts';
import { CUA } from '../src/definition.ts';
import { CUA_DEFAULTS } from '../src/config.ts';
import { CuaWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

describe('parseKeys', () => {
  it('reads chords and sequences, case-insensitively', () => {
    expect(parseKeys('Ctrl+S')).toEqual({ chords: [[{ vk: 0x11, extended: false }, { vk: 0x53, extended: false }]] });
    const seq = parseKeys('ctrl+a delete');
    expect('chords' in seq && seq.chords.map((c) => c.map((k) => k.vk))).toEqual([[0x11, 0x41], [0x2E]]);
    expect(parseKeys('ctrl++')).toEqual({ chords: [[{ vk: 0x11, extended: false }, { vk: 0xBB, extended: false }]] });
  });

  it('marks navigation keys as extended', () => {
    const r = parseKeys('left');
    expect('chords' in r && r.chords[0][0]).toEqual({ vk: 0x25, extended: true });
  });

  it('names the first unknown key', () => {
    expect(parseKeys('ctrl+hyper')).toEqual({ error: '不认识的键「hyper」' });
    expect(parseKeys('   ')).toEqual({ error: '没有给出按键' });
  });
});

describe('image', () => {
  it('fits without upscaling and keeps the aspect ratio', () => {
    expect(fit(2560, 1600, 1280, 800)).toEqual({ width: 1280, height: 800, scale: .5 });
    expect(fit(1920, 1080, 1280, 800)).toMatchObject({ width: 1280, height: 720 });
    expect(fit(800, 600, 1280, 800)).toEqual({ width: 800, height: 600, scale: 1 });
  });

  it('averages each output pixel over its source box and swaps BGRA to RGBA', () => {
    // 2×2 BGRA → 1×1: blue channel 0 and 200 average to 100, red 40 and 0 to 20
    const bgra = new Uint8Array([0, 0, 40, 255, 200, 0, 0, 255, 0, 0, 40, 255, 200, 0, 0, 255]);
    expect([...downscale(bgra, 2, 2, { width: 1, height: 1, scale: .5 })]).toEqual([20, 0, 100, 255]);
  });

  it('draws the pointer and encodes a JPEG of the requested size', () => {
    const rgba = new Uint8Array(40 * 30 * 4).fill(128);
    drawCursor(rgba, 40, 30, 5, 5);
    expect(rgba[(5 * 40 + 5) * 4]).toBe(0); // arrow tip is outline
    expect(rgba[(7 * 40 + 6) * 4]).toBe(255); // inside is filled white
    const out = jpeg.decode(encodeJpeg(rgba, 40, 30, 80));
    expect([out.width, out.height]).toEqual([40, 30]);
  });
});

describe('CuaWorld without the engine', () => {
  const world = () => {
    const cfg = structuredClone(CUA_DEFAULTS);
    return { cfg, world: new CuaWorld({ cfg, timezone: 'Asia/Shanghai' }) };
  };
  const call = (w: CuaWorld, name: string, args: Record<string, unknown>) =>
    w.tools().find((t) => t.name === name)!.handler(args, { role: 'main', log: new FakeHost().log }) as Promise<{ text: string; failed?: true }>;

  it('rejects points outside the screenshot before touching the screen', async () => {
    const { world: w } = world();
    const out = await call(w, 'cua_click', { x: 5000, y: 10 });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('不在截图范围内');
  });

  it('refuses input when control is off', async () => {
    const { world: w, cfg } = world();
    cfg.control = false;
    for (const [name, args] of [['cua_click', { x: 1, y: 1 }], ['cua_type', { text: 'x' }], ['cua_key', { keys: 'enter' }], ['cua_focus', { window: 'x' }]] as const) {
      const out = await call(w, name, args);
      expect(out.failed).toBe(true);
      expect(out.text).toContain('worlds.cua.control');
    }
  });

  it('reports an unknown key without pressing anything', async () => {
    const { world: w } = world();
    expect(await call(w, 'cua_key', { keys: 'ctrl+nope' })).toEqual({ text: '[cua_key 没执行] 不认识的键「nope」。', failed: true });
  });

  it('asks once per turn before touching the screen; a refusal fails every call of that turn', async () => {
    const asked: string[] = [];
    let answer: 'no' | 'timeout' = 'no';
    const w = new CuaWorld({ cfg: structuredClone(CUA_DEFAULTS), timezone: 'Asia/Shanghai', botName: 'Bot', askPermission: async (q) => { asked.push(q); return answer; } });
    const shot = await call(w, 'cua_screenshot', {});
    const click = await call(w, 'cua_click', { x: 1, y: 1 });
    expect([shot.failed, click.failed]).toEqual([true, true]);
    expect(shot.text).toContain('没有允许');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Bot');
    w.onTurnEnded();
    answer = 'timeout';
    expect((await call(w, 'cua_windows', {})).text).toContain('没有回应');
    expect(asked).toHaveLength(2);
  });

  it('checks arguments before asking', async () => {
    const asked: string[] = [];
    const w = new CuaWorld({ cfg: structuredClone(CUA_DEFAULTS), timezone: 'Asia/Shanghai', askPermission: async (q) => { asked.push(q); return 'no'; } });
    expect((await call(w, 'cua_click', { x: 5000, y: 10 })).text).toContain('不在截图范围内');
    expect(asked).toEqual([]);
  });

  it('passes the extension dry mount', async () => {
    const report = await dryMountWorld(CUA as never, { scratchDir: mkdtempSync(join(tmpdir(), 'cua-dry-')) });
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe('the macOS engine\'s pure parts', () => {
  it('maps the keys cua_key names to Mac key codes, modifiers with their flags', () => {
    const r = parseKeys('cmd+shift+s');
    const keys = 'chords' in r ? r.chords[0]!.map((k) => macKey(k.vk)) : [];
    expect(keys).toEqual([{ key: 0x37, flag: 0x100000 }, { key: 0x38, flag: 0x20000 }, { key: 0x01, flag: 0 }]);
    for (const name of ['enter', 'esc', 'tab', 'backspace', 'delete', 'left', 'pagedown', 'f12', ';', '[', "'", 'a', '0']) {
      const k = parseKeys(name);
      expect('chords' in k && macKey(k.chords[0]![0]!.vk), name).not.toBeNull();
    }
    // keys a Mac keyboard does not have
    for (const name of ['printscreen', 'menu', 'f24']) {
      const k = parseKeys(name);
      expect('chords' in k && macKey(k.chords[0]![0]!.vk), name).toBeNull();
    }
  });

  it('reads the reply of a yes/no dialog', () => {
    expect(dialogAnswer('button returned:可以, gave up:false\n', '可以')).toBe('yes');
    expect(dialogAnswer('button returned:不行, gave up:false', '可以')).toBe('no');
    expect(dialogAnswer('button returned:, gave up:true', '可以')).toBe('timeout');
  });

  it('quotes text for AppleScript', () => {
    expect(appleString('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });

  it('cuts typed text into key events without splitting an emoji', () => {
    const chunks = unicodeChunks('a'.repeat(19) + '😀b', 20);
    expect(chunks.map((c) => c.length)).toEqual([19, 3]);
    expect(String.fromCharCode(...chunks[1]!)).toBe('😀b');
  });
});
