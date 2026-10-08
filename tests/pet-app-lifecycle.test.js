import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ loadBody: vi.fn() }));
vi.mock('../packages/cortico-world-desktop-pet/web/body-host.js', () => ({ loadBody: mocks.loadBody }));
vi.mock('../packages/cortico-world-desktop-pet/web/sound.js', () => ({
  createSfx: () => new Proxy({}, { get: () => () => {} }),
}));
let dom;
async function fixture(native = true) {
  vi.resetModules(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  dom = new JSDOM(readFileSync(new URL('../packages/cortico-world-desktop-pet/web/pet.html', import.meta.url), 'utf8'), { url: 'http://localhost/pet', pretendToBeVisual: true });
  const { window } = dom, sockets = [];
  let lifecycle, cursor;
  const host = { setInteractive: vi.fn(), grabFocus: vi.fn(), releaseFocus: vi.fn(), focus: vi.fn(),
    show: vi.fn(() => lifecycle({ active: true })),
    onRenderState: cb => { lifecycle = cb; }, onCursor: cb => { cursor = cb; }, hideWhenFullscreen: vi.fn(),
    followCursor: vi.fn(async () => null),
  };
  if (native) window.petHost = host;
  const body = { pack: 'hachimist', layout: { x: 400, facing: 1, mode: 'idle', busy: false, moving: false, pressing: false, cursor: '',
    bubble: { x: 400, y: 500 }, side: { x: 400, y: 500, reach: 25 }, box: { x: 350, y: 450, w: 100, h: 100 } },
    set: vi.fn(), tick: vi.fn(), pointer: vi.fn(), hit: vi.fn(() => false), setHalo: vi.fn(), dispose: vi.fn(),
    talk: vi.fn(), cue: vi.fn(), walk: vi.fn(), do: vi.fn(), shift: vi.fn(), drop: vi.fn(),
  };
  mocks.loadBody.mockResolvedValue(body);
  window.document.elementFromPoint = () => window.document.body;
  const stage = window.document.querySelector('#stage');
  stage.setPointerCapture = vi.fn(); stage.hasPointerCapture = () => true; stage.releasePointerCapture = vi.fn();
  class Socket {
    readyState = 1; sent = [];
    constructor() { sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
  }
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, location: window.location,
    innerWidth: 1024, innerHeight: 768, addEventListener: window.addEventListener.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window), WebSocket: Socket,
    requestAnimationFrame: cb => setTimeout(() => cb(performance.now()), 16), cancelAnimationFrame: id => clearTimeout(id),
    fetch: vi.fn(async () => ({ json: async () => [{ id: 'hachimist', vocab: [], base: '/figure/' }] })),
  })) vi.stubGlobal(key, value);
  await import('../packages/cortico-world-desktop-pet/web/pet-app.js');
  const order = m => sockets[0].onmessage({ data: JSON.stringify(m) });
  order({ t: 'init', skin: { figure: 'hachimist' }, roam: 'off', mic: false });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  return { body, host, order, stage, bubble: window.document.querySelector('#bubble'),
    visible: active => lifecycle({ active }), cursor: p => cursor(p), sent: sockets[0].sent,
    bodyEvent: mocks.loadBody.mock.calls.at(-1)[0].onEvent,
    advance: ms => vi.advanceTimersByTimeAsync(ms), window,
  };
}

afterEach(() => { dom?.window.close(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('pet page lifecycle', () => {
  it('receives hidden say/ask orders without drawing; resumes both without losing a pending answer', async () => {
    const f = await fixture();
    expect(f.window.document.hidden).toBe(false); // Electron can report this even while natively hidden.
    f.order({ t: 'say', id: 1, beats: [{ text: 'Hi' }] });
    f.order({ t: 'ask', id: 2, question: 'Ready?', options: ['Yes'], own: false });
    await f.advance(60_000); expect(f.body.tick).not.toHaveBeenCalled(); expect(f.bubble.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    f.visible(true); await f.advance(200); expect(f.bubble.textContent).toContain('Hi');
    await f.advance(3500); expect(f.bubble.textContent).toContain('Ready?');
    expect(f.host.grabFocus).toHaveBeenCalledOnce();
    f.visible(false); expect(f.host.releaseFocus).toHaveBeenCalledOnce();
    f.bubble.querySelector('.b-opt').click();
    expect(f.sent.some(m => m.t === 'answer')).toBe(false);
    const frames = f.body.tick.mock.calls.length;
    await f.advance(60_000); expect(f.body.tick).toHaveBeenCalledTimes(frames);
    f.visible(true); await f.advance(16); expect(f.body.tick.mock.calls.at(-1)[0]).toBe(0);
    expect(f.host.grabFocus).toHaveBeenCalledTimes(2);
    f.bubble.querySelector('.b-opt').click();
    expect(f.sent).toContainEqual({ t: 'answer', askId: 2, index: 0 });
  });

  it('handles a World reveal while hidden without replacing the queued question', async () => {
    const f = await fixture();
    f.order({ t: 'ask', id: 'pending', question: 'Keep this?', options: ['Yes'], own: false });
    await f.advance(60_000); expect(f.body.tick).not.toHaveBeenCalled();
    f.order({ t: 'show-window' });
    expect(f.host.show).toHaveBeenCalledOnce();
    await f.advance(1200); expect(f.bubble.textContent).toContain('Keep this?');
    f.visible(false); f.order({ t: 'show-window' }); await f.advance(100);
    expect(f.host.show).toHaveBeenCalledTimes(2);
    f.bubble.querySelector('.b-opt').click();
    expect(f.sent).toContainEqual({ t: 'answer', askId: 'pending', index: 0 });
  });

  it('does not acknowledge unread hidden dialogs; hidden updates invalidate the old read deadline', async () => {
    const f = await fixture(); f.visible(true);
    f.order({ t: 'dialog', id: 'read', text: 'Hi' }); await f.advance(600);
    f.visible(false); await f.advance(120_000);
    expect(f.sent.some(m => m.t === 'dialog')).toBe(false);
    f.visible(true); await f.advance(16);
    expect(f.sent.some(m => m.t === 'dialog')).toBe(false);
    f.visible(false);
    f.order({ t: 'dialog-update', id: 'read', text: 'A'.repeat(100) });
    f.visible(true); await f.advance(2000);
    expect(f.sent.some(m => m.t === 'dialog')).toBe(false);
    expect(f.bubble.querySelector('.b-text').textContent.length).toBeLessThan(100);
    await f.advance(12_000); expect(f.sent).toContainEqual({ t: 'dialog', id: 'read', done: true });
  });

  it('honors close messages while hidden and keeps action/walk orders alive', async () => {
    const f = await fixture();
    f.order({ t: 'dialog', id: 'old', text: 'Expired' }); f.order({ t: 'dialog-close', id: 'old' });
    f.order({ t: 'ask', id: 'oldask', question: 'Expired?', options: ['Yes'] }); f.order({ t: 'ask-close', id: 'oldask' });
    f.order({ t: 'act', actions: ['wave'] }); f.order({ t: 'walk', id: 'walk', to: .4 });
    expect(f.body.walk).toHaveBeenCalledWith(409.6, false, 'walk');
    expect(f.body.do).not.toHaveBeenCalled();
    f.visible(true); await f.advance(1000);
    expect(f.body.do).toHaveBeenCalledWith('wave'); expect(f.bubble.hidden).toBe(true);
    expect(f.sent.some(m => ['dialog', 'answer', 'interrupted'].includes(m.t))).toBe(false);
  });

  it('ignores hidden in-flight touches while still delivering legitimate walk completions', async () => {
    const f = await fixture();
    f.order({ t: 'walk', id: 'arriving', to: .4 });
    f.bodyEvent('touch', { kind: 'poke' });
    f.bodyEvent('arrived', { walkId: 'arriving', x: 409.6 });
    expect(f.sent.some(m => m.t === 'touch')).toBe(false);
    expect(f.sent).toContainEqual({ t: 'arrived', walkId: 'arriving', x: .4 });
    f.visible(true); f.bodyEvent('touch', { kind: 'poke' });
    expect(f.sent).toContainEqual({ t: 'touch', kind: 'poke' });
  });

  it('resets pointer/gaze, cancels capture, and rejects a stale cross-display drag response', async () => {
    const f = await fixture(); f.visible(true); await f.advance(16);
    f.body.hit.mockReturnValue(true);
    const down = new f.window.MouseEvent('pointerdown', { button: 0, clientX: 400, clientY: 480, bubbles: true });
    Object.defineProperty(down, 'pointerId', { value: 7 }); f.stage.dispatchEvent(down);
    f.body.layout.mode = 'drag';
    let resolve; f.host.followCursor.mockImplementation(() => new Promise(r => { resolve = r; }));
    f.window.document.dispatchEvent(new f.window.MouseEvent('pointermove', { clientX: 1100, clientY: 400 }));
    expect(f.host.followCursor).toHaveBeenCalledOnce();
    f.visible(false); f.visible(true);
    resolve({ x: 100, y: 100, w: 1024, h: 768, dx: 100, dy: 0 }); await Promise.resolve(); await Promise.resolve();
    expect(f.body.shift).not.toHaveBeenCalled(); expect(f.body.drop).not.toHaveBeenCalled();
    expect(f.stage.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(f.body.pointer).toHaveBeenCalledWith('cancel', {});
    expect(f.body.pointer).toHaveBeenCalledWith('suspend', {});
  });

  it('uses document visibility for ordinary browser tabs and resumes without a time jump', async () => {
    const f = await fixture(false); await f.advance(100);
    const before = f.body.tick.mock.calls.length; expect(before).toBeGreaterThan(0);
    Object.defineProperty(f.window.document, 'hidden', { value: true, configurable: true });
    f.window.document.dispatchEvent(new f.window.Event('visibilitychange'));
    await f.advance(60_000); expect(f.body.tick).toHaveBeenCalledTimes(before);
    Object.defineProperty(f.window.document, 'hidden', { value: false, configurable: true });
    f.window.document.dispatchEvent(new f.window.Event('visibilitychange'));
    await f.advance(16); expect(f.body.tick.mock.calls.at(-1)[0]).toBe(0);
  });
});
