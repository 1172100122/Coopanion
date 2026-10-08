import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { loadBody } from '../packages/cortico-world-desktop-pet/web/body-host.js';
import { createPointerGaze } from '../packages/cortico-world-desktop-pet/web/kit/pointer-gaze.js';
import { createPet } from '../packages/cortico-world-desktop-pet/web/kit/body.js';
import { createHachimistFigure, spriteState } from '../packages/cortico-world-desktop-pet/web/hachimist/figure.js';

const point = (x, y = 100) => ({ x, y, screenX: x, screenY: y });
function gate() {
  let time = 100;
  const gaze = createPointerGaze(4, () => time);
  return { gaze, at: n => { time = n; } };
}

describe('bounded pointer gaze', () => {
  it('starts on entry, expires at four real seconds, and never renews the same hover', () => {
    const { gaze, at } = gate();
    gaze.observe(point(0), false); expect(gaze.active).toBe(false);
    gaze.observe(point(1), true); expect(gaze.active).toBe(true);
    at(4000); gaze.observe(point(2), true); expect(gaze.active).toBe(true);
    at(4100); expect(gaze.active).toBe(false);
    gaze.observe(point(3), true); expect(gaze.active).toBe(false);
    gaze.observe(point(0), false); gaze.observe(point(4), true); expect(gaze.active).toBe(true);
    at(8100); expect(gaze.active).toBe(false);
  });
  it('keeps tracking outside without renewing the deadline, and allows a genuine re-entry', () => {
    const { gaze, at } = gate();
    gaze.observe(point(1), true); at(1000); gaze.observe(point(2), false);
    expect(gaze.active).toBe(true); gaze.leave(); at(4100); expect(gaze.active).toBe(false);
    gaze.observe(point(3), true); expect(gaze.active).toBe(true);
  });
  it('baselines the first passive sample and recovers click-through entries from later polls', () => {
    const { gaze, at } = gate();
    gaze.observe(point(1), true, 'cursor'); gaze.observe(point(2), true, 'cursor');
    expect(gaze.active).toBe(false);
    gaze.observe(point(0), false, 'cursor'); gaze.observe(point(3), true, 'cursor');
    expect(gaze.active).toBe(true);
    at(4100); gaze.observe(point(4), true, 'cursor'); expect(gaze.active).toBe(false);
  });
  it.each([['move', 'cursor'], ['cursor', 'move']])('deduplicates %s then %s without extending the window', (first, second) => {
    const { gaze, at } = gate();
    gaze.observe(point(0), false, 'cursor'); gaze.observe(point(1), true, first);
    at(2000); gaze.observe(point(1), true, second);
    at(4100); expect(gaze.active).toBe(false);
  });
  it('ignores hit-geometry and window-position changes under the same screen cursor', () => {
    const { gaze } = gate();
    gaze.observe(point(50), false, 'cursor');
    gaze.observe({ ...point(50), x: 300, y: 200 }, true, 'cursor');
    gaze.observe({ ...point(50), x: 301, y: 201 }, true);
    expect(gaze.active).toBe(false);
  });
  it('rearms after a confirmed exit from the window even when returning to the exact same pixel', () => {
    const { gaze, at } = gate();
    gaze.observe(point(1), true); at(4100); gaze.observe(null, false, 'cursor');
    gaze.observe(point(1), true, 'cursor'); expect(gaze.active).toBe(true);
  });
  it('records a DOM departure and allows return to the exact entry pixel', () => {
    const { gaze, at } = gate();
    gaze.observe(point(1), true); at(4100); gaze.leave(point(0));
    gaze.observe(point(1), true); expect(gaze.active).toBe(true);
    at(8100); gaze.leave(); gaze.observe(point(1), true); expect(gaze.active).toBe(true);
  });
  it('cancels on suspension without rearming inside; a fresh instance has no stale gaze', () => {
    const { gaze } = gate();
    gaze.observe(point(1), true); gaze.suspend(); gaze.observe(point(2), true);
    expect(gaze.active).toBe(false);
    gaze.observe(point(0), false); gaze.observe(point(3), true); expect(gaze.active).toBe(true);
    expect(gate().gaze.active).toBe(false);
  });
});

async function fixture(bounded = true) {
  const dom = new JSDOM('<svg><ellipse/><g/><g/></svg>');
  const [shadowEl, petG, fxG] = dom.window.document.querySelector('svg').children;
  const figure = await createHachimistFigure(new URL('https://example.invalid/'), {
    asset: p => p, loadImage: async p => ({ naturalWidth: p.startsWith('actions/') ? 1152 : 1536, naturalHeight: p.startsWith('actions/') ? 208 : 2288 }),
  });
  if (!bounded) delete figure.pointerGazeSeconds;
  let time = 100;
  const frames = [], events = [];
  figure.draw = (g, face, frame) => frames.push(structuredClone(frame));
  const ctl = createPet({ shadowEl, petG, fxG }, {
    figure, clock: () => time, bounds: () => ({ W: 900, H: 500, floorY: 450, S: .8 }), roam: 'off',
    sfx: {}, onEvent: (kind, detail) => events.push({ kind, detail }),
  });
  const advance = seconds => { for (let i = 0; i < Math.round(seconds * 60); i++) { time += 1000 / 60; ctl.step(1 / 60); ctl.render(); } };
  const state = () => spriteState(frames.at(-1));
  advance(.1);
  const enter = () => { ctl.pointerMove({ ...ctl.toStage(154, 120), t: time }); advance(.05); };
  return { ctl, frames, events, advance, state, enter, skip: ms => { time += ms; } };
}

describe('Hachimist gaze through the real body', () => {
  it('does not gaze from empty space; first entry is a glance, not accidental petting', async () => {
    const { ctl, events, enter, state, advance } = await fixture();
    ctl.pointerMove({ x: 880, y: 100 }); advance(.2); expect(state()).toBe('idle');
    enter(); expect(state()).toBe('look'); expect(events.some(e => e.kind === 'touch')).toBe(false);
    const direct = await fixture(); direct.enter(); expect(direct.state()).toBe('look');
    expect(direct.events.some(e => e.kind === 'touch')).toBe(false);
  });
  it('blinks during gaze, then returns to actual idle even with residual eased look and ongoing input', async () => {
    const { ctl, enter, advance, frames, state } = await fixture();
    enter(); ctl.pet.blinkT = .2; advance(.5);
    expect(frames.map(spriteState)).toContain('blink'); expect(state()).toBe('look');
    for (let i = 0; i < 42; i++) { ctl.pointerMove(ctl.toStage(154 + i % 2, 120)); advance(.1); }
    expect(frames.at(-1).pointerGaze).toBe(false);
    expect(['idle', 'blink']).toContain(state());
    ctl.pet.look = [5, 4]; ctl.render(); expect(['idle', 'blink']).toContain(state());
  });
  it('follows passive cursor positions outside, does not pet, and expires while animation is throttled', async () => {
    const { ctl, enter, advance, frames, skip, state, events } = await fixture();
    enter(); ctl.pointerCursor({ x: 850, y: 130 }); advance(.3);
    expect(state()).toBe('look'); const before = [...frames.at(-1).look];
    ctl.pointerCursor({ x: 500, y: 300 }); advance(.3); expect(frames.at(-1).look).not.toEqual(before);
    expect(events.some(e => e.kind === 'touch')).toBe(false);
    skip(5000); ctl.step(.05); ctl.render();
    expect(frames.at(-1).pointerGaze).toBe(false); expect(['idle', 'blink']).toContain(state());
  });
  it('does not turn toward a stale pointer after expiry', async () => {
    const { ctl, enter, advance, skip } = await fixture();
    enter(); skip(5000); ctl.pointerCursor({ x: 450, y: 330 });
    const facing = ctl.pet.facing; advance(1.5); expect(ctl.pet.facing).toBe(facing);
  });
  it('ignores a synthetic leave still inside the body and does not renew subsequent hover movement', async () => {
    const { ctl, enter, skip, advance, frames } = await fixture();
    enter(); skip(5000); ctl.pointerLeave(ctl.toStage(154, 120));
    ctl.pointerMove(ctl.toStage(155, 120)); advance(.1);
    expect(frames.at(-1).pointerGaze).toBe(false);
  });
  it('passive cursor samples neither erase physical petting distance nor steer a drag', async () => {
    const petCounts = [];
    for (const polls of [false, true]) {
      const { ctl, events, enter } = await fixture(); enter();
      for (let i = 0; i < 14; i++) {
        const p = { ...ctl.toStage(i % 2 ? 108 : 148, 112), t: 500 + i * 25 };
        if (polls) ctl.pointerCursor(p);
        ctl.pointerMove(p);
      }
      petCounts.push(events.filter(e => e.kind === 'touch' && e.detail.kind === 'pet').length);
    }
    expect(petCounts).toEqual([1, 1]);
    const { ctl, advance } = await fixture(); const p = ctl.toStage(128, 112);
    ctl.pointerDown({ ...p, t: 1000 }); ctl.pointerMove({ x: p.x + 30, y: p.y - 30, t: 1100 }); advance(.1);
    ctl.pointerCursor({ x: 850, y: 100 }); advance(.2);
    expect(ctl.pet.mode).toBe('drag'); expect(ctl.pet.dx).toBeLessThan(p.x + 40);
  });
  it.each(['walk', 'run', 'sit', 'sleep', 'wave'])('%s retains priority and cannot resurrect an expired gaze', async action => {
    const { ctl, enter, advance, skip, state, frames } = await fixture();
    enter(); ctl.doWord(action); advance(.2);
    const expected = { walk: 'running-', run: 'running-', sit: 'sit', sleep: 'sleep', wave: 'waving' }[action];
    expect(state().startsWith(expected)).toBe(true);
    skip(5000); ctl.doWord('stand'); ctl.doWord('neutral'); advance(2);
    expect(frames.at(-1).pointerGaze).toBe(false); expect(['idle', 'blink']).toContain(state());
  });
  it('speech wins during gaze and returns to idle after the deadline; explicit look still works', async () => {
    const { ctl, enter, advance, skip, state } = await fixture();
    enter(); ctl.talk(); advance(.1); expect(state()).toBe('talk');
    skip(5000); advance(.5); expect(['idle', 'blink']).toContain(state());
    ctl.doWord('look'); advance(.2); expect(state()).toBe('look');
  });
  it('figure replacement clears the old gaze deadline and same-pointer native baseline', async () => {
    const { ctl, enter, frames, advance } = await fixture();
    enter(); ctl.setFigure({ pointerGazeSeconds: 4, draw: (g, face, f) => frames.push(structuredClone(f)) });
    ctl.pointerCursor(ctl.toStage(154, 120)); advance(.2);
    expect(frames.at(-1).pointerGaze).toBe(false);
  });
  it('figures without the opt-in keep continuous Coo-style tracking and ignore passive samples', async () => {
    const { ctl, advance, frames, skip } = await fixture(false);
    ctl.pointerMove({ x: 850, y: 260 }); advance(.3); skip(10000); advance(.3);
    expect(Math.hypot(...frames.at(-1).look)).toBeGreaterThan(2);
    expect(frames.at(-1).pointerGaze).toBeUndefined();
    ctl.pointerCursor({ x: 50, y: 10 }); ctl.suspendGaze(); advance(.3);
    expect(frames.at(-1).look[0]).toBeGreaterThan(0);
  });
});

describe('gaze host lifecycle and input isolation', () => {
  it('passive cursor/suspend cannot authorize touches; blur/hidden cancel and disposal removes listeners', async () => {
    const dom = new JSDOM('<div id="layer"></div>', { url: 'http://localhost/' });
    const { window } = dom;
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('location', window.location);
    vi.stubGlobal('addEventListener', window.addEventListener.bind(window));
    vi.stubGlobal('removeEventListener', window.removeEventListener.bind(window));
    const events = [];
    let body;
    try {
      const loading = loadBody({ layer: window.document.querySelector('#layer'), pack: { id: 'hachimist' }, start: {}, bounds: { W: 900, H: 500, S: .8 }, onEvent: (kind, detail) => events.push({ kind, detail }) });
      const frame = window.document.querySelector('iframe'), sent = [];
      vi.spyOn(frame.contentWindow, 'postMessage').mockImplementation(m => sent.push(m));
      const receive = data => window.dispatchEvent(new window.MessageEvent('message', { source: frame.contentWindow, data }));
      receive({ t: 'ready' }); body = await loading;
      const touch = () => receive({ t: 'frame', layout: {}, events: [{ kind: 'touch', detail: { kind: 'poke' } }] });
      body.pointer('cursor', point(100)); body.pointer('suspend', {}); touch(); expect(events).toHaveLength(0);
      window.dispatchEvent(new window.Event('blur'));
      Object.defineProperty(window.document, 'hidden', { configurable: true, value: true });
      window.document.dispatchEvent(new window.Event('visibilitychange'));
      expect(sent.filter(m => m.type === 'suspend')).toHaveLength(3);
      body.pointer('move', point(101)); touch(); expect(events).toHaveLength(1);
      body.dispose(); const count = sent.length;
      window.dispatchEvent(new window.Event('blur'));
      window.document.dispatchEvent(new window.Event('visibilitychange'));
      expect(sent).toHaveLength(count);
    } finally { body?.dispose(); vi.unstubAllGlobals(); window.close(); }
  });
});
