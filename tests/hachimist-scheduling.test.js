import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createPet } from '../packages/cortico-world-desktop-pet/web/kit/body.js';
import { spriteCell, spriteState } from '../packages/cortico-world-desktop-pet/web/hachimist/figure.js';

function fixture(stationary = true) {
  const dom = new JSDOM('<svg><ellipse/><g/><g/></svg>');
  const [shadowEl, petG, fxG] = dom.window.document.querySelector('svg').children;
  const frames = [], events = [];
  const ctl = createPet({ shadowEl, petG, fxG }, {
    bounds: () => ({ W: 900, H: 500, floorY: 450, S: .8 }), roam: 'off',
    sfx: {}, onEvent: (kind, detail) => events.push({ kind, detail }),
    figure: { gestures: ['wave'], stationaryGestures: stationary ? ['wave'] : [], draw: (g, face, f) => frames.push(structuredClone(f)) },
  });
  const advance = seconds => { for (let i = 0; i < Math.ceil(seconds * 60); i++) { ctl.step(1 / 60); ctl.render(); } };
  advance(.1);
  return { ctl, frames, events, advance };
}

describe('Hachimist scheduling', () => {
  it('blinks with a persistent pointer and resumes its directional gaze', () => {
    const { ctl, frames, advance } = fixture();
    ctl.pointerMove({ x: 850, y: 260, t: 100 }); ctl.pet.blinkT = .4; advance(.9);
    const states = frames.map(spriteState);
    expect(states).toContain('look'); expect(states).toContain('blink'); expect(states.at(-1)).toBe('look');
    const blink = frames.find(f => spriteState(f) === 'blink');
    expect(Math.hypot(...blink.look)).toBeGreaterThan(2);
    expect(spriteCell('blink', blink, 0)).toEqual({ row: 0, column: 2 });
  });
  it.each([false, true])('stops locomotion (run=%s) and displays a complete explicit wave immediately', run => {
    const { ctl, frames, events, advance } = fixture();
    ctl.walkTo(110, run, 42); advance(.4); const stoppedAt = ctl.pet.x;
    expect(ctl.doWord('wave')).toBe(true); advance(1.6);
    expect(ctl.pet.x).toBe(stoppedAt);
    expect(events.filter(e => e.kind === 'interrupted')).toEqual([{ kind: 'interrupted', detail: { walkId: 42, x: Math.round(stoppedAt), by: 'idle' } }]);
    const wave = frames.filter(f => spriteState(f) === 'waving');
    expect(wave.length).toBeGreaterThan(85);
    expect(new Set(wave.map(f => spriteCell('waving', f, 0).column)).size).toBe(4);
    advance(.4); expect(ctl.pet.pulse).toBeNull();
  });
  it('defers a wave until landing completes and coalesces repeated pending waves', () => {
    const { ctl, frames, advance } = fixture();
    ctl.doWord('jump'); advance(.2); expect(ctl.pet.mode).toBe('air');
    expect(ctl.doWord('wave')).toBe(true); expect(ctl.doWord('wave')).toBe(true); expect(ctl.pet.pulse).toBeNull();
    advance(3); const wave = frames.filter(f => f.gesture?.kind === 'wave');
    expect(wave.length).toBeGreaterThan(85); expect(wave.every(f => f.mode === 'idle')).toBe(true);
    expect(wave[0].gesture.k).toBeLessThan(.03); expect(wave.length).toBeLessThan(100);
  });
  it('newer commands cancel queued and active waves, including during physics', () => {
    const { ctl, frames, advance } = fixture();
    ctl.doWord('jump'); advance(.2); ctl.doWord('wave');
    expect(ctl.doWord('stand')).toBe(false); // A newer intent cancels even though standing in the air is impossible.
    advance(2); expect(frames.some(f => f.gesture?.kind === 'wave')).toBe(false);
    ctl.doWord('wave'); advance(.2); ctl.doWord('sit'); advance(.2);
    expect(ctl.pet.mode).toBe('sit'); expect(ctl.pet.pulse).toBeNull();
    ctl.doWord('wave'); advance(.2); ctl.walkTo(120, false, 3); advance(.2);
    expect(ctl.pet.mode).toBe('walk'); expect(ctl.pet.pulse).toBeNull();
  });
  it('direct motion and expression APIs cancel queued or active whole-body gestures', () => {
    const { ctl, frames, advance } = fixture();
    ctl.act('jump'); advance(.2); ctl.act('wave');
    expect(ctl.act('stand')).toBe(false); advance(2);
    expect(frames.some(f => f.gesture?.kind === 'wave')).toBe(false);
    ctl.act('wave'); advance(.2); ctl.setExpr('sad'); advance(.1);
    expect(ctl.pet.pulse).toBeNull(); expect(frames.at(-1).face).toBe('sad');
  });
  it('restarting a wave resets its strip clock; unknown words do not cancel it', () => {
    const { ctl, frames, advance } = fixture();
    ctl.doWord('wave'); advance(.4); expect(spriteCell('waving', frames.at(-1), 100).column).toBe(2);
    ctl.doWord('wave'); advance(.02); expect(spriteCell('waving', frames.at(-1), 100).column).toBe(0);
    expect(ctl.doWord('unknown')).toBe(false); expect(ctl.pet.pulse.kind).toBe('wave');
  });
  it('drag cancels an active wave; a new wave during dragging waits until the body settles', () => {
    const { ctl, frames, advance } = fixture();
    ctl.doWord('wave'); advance(.2); const p = ctl.toStage(128, 128);
    expect(ctl.pointerDown({ ...p, t: 1000 })).toBe(true); expect(ctl.pet.pulse).toBeNull();
    ctl.pointerMove({ x: p.x + 30, y: p.y - 35, t: 1100 }); advance(.1); expect(ctl.pet.mode).toBe('drag');
    ctl.doWord('wave'); advance(.3); expect(ctl.pet.pulse).toBeNull();
    ctl.dropAt({ x: p.x + 30, y: 100 }); advance(4);
    const wave = frames.filter(f => f.t > .8 && f.gesture?.kind === 'wave');
    expect(wave.length).toBeGreaterThan(50); expect(wave.every(f => f.mode === 'idle')).toBe(true);
  });
  it('listening, thinking, and figure replacement clear deferred gestures', () => {
    for (const cancel of [c => c.setListening(true), c => c.setThinking(true), c => c.setFigure({ draw() {}, gestures: ['wave'], stationaryGestures: ['wave'] })]) {
      const { ctl, frames, advance } = fixture();
      ctl.doWord('jump'); advance(.2); ctl.doWord('wave'); cancel(ctl); advance(3);
      expect(frames.some(f => f.gesture?.kind === 'wave')).toBe(false);
    }
  });
  it('keeps legacy layered gestures unchanged for figures that did not opt in', () => {
    const { ctl, advance } = fixture(false);
    ctl.walkTo(100, false, 7); advance(.2); ctl.doWord('wave'); advance(.1);
    expect(ctl.pet.mode).toBe('walk'); expect(ctl.pet.walkId).toBe(7); expect(ctl.pet.pulse.kind).toBe('wave');
  });
});
