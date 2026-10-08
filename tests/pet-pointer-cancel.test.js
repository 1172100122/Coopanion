import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createPet } from '../packages/cortico-world-desktop-pet/web/kit/body.js';

function fixture() {
  const dom = new JSDOM('<svg><ellipse/><g/><g/></svg>');
  const [shadowEl, petG, fxG] = dom.window.document.querySelector('svg').children;
  const events = [];
  const ctl = createPet({ shadowEl, petG, fxG }, {
    bounds: () => ({ W: 900, H: 500, floorY: 450, S: .8 }), roam: 'off', sfx: {},
    onEvent: (kind, detail) => events.push({ kind, detail }), figure: { draw() {} },
  });
  ctl.step(.1); ctl.render();
  return { ctl, events };
}

describe('pet pointer cancellation', () => {
  it('baselines stale coordinates on first/resumed entry for non-gaze figures without disabling real petting', () => {
    const { ctl, events } = fixture(), p = ctl.toStage(128, 128);
    ctl.pointerMove({ ...p, t: 100 });
    expect(events.filter(e => e.kind === 'touch')).toEqual([]);
    ctl.pointerMove({ x: p.x + 1000, y: p.y, t: 200 });
    ctl.pointerCancel();
    ctl.pointerMove({ ...p, t: 60_000 });
    expect(events.filter(e => e.kind === 'touch')).toEqual([]);
    for (let i = 0; i < 16; i++) ctl.pointerMove({ x: p.x + (i % 2 ? -20 : 20), y: p.y, t: 60_100 + i * 20 });
    expect(events.filter(e => e.kind === 'touch').map(e => e.detail.kind)).toEqual(['pet']);
  });
  it('never synthesizes a poke when a short press is interrupted', () => {
    const { ctl, events } = fixture(), p = ctl.toStage(128, 128);
    expect(ctl.pointerDown({ ...p, t: 100 })).toBe(true);
    ctl.pointerCancel(); ctl.pointerUp({ ...p, t: 150 });
    expect(ctl.layout().pressing).toBe(false);
    expect(events.filter(e => e.kind === 'touch')).toEqual([]);
  });
  it('releases dragging with zero throw velocity and no synthetic touch or crash', () => {
    const { ctl, events } = fixture(), p = ctl.toStage(128, 128);
    ctl.pointerDown({ ...p, t: 100 });
    ctl.pointerMove({ x: p.x + 250, y: p.y - 200, t: 110 });
    ctl.step(.05); ctl.render(); expect(ctl.pet.mode).toBe('drag');
    events.length = 0; ctl.pointerCancel();
    expect(ctl.layout().pressing).toBe(false); expect(ctl.pet.mode).toBe('air');
    expect([ctl.pet.vx, ctl.pet.vy]).toEqual([0, 0]); expect(ctl.pet.airKind).toBe('drop');
    ctl.pointerUp({ ...p, t: 120 });
    for (let i = 0; i < 240; i++) { ctl.step(1 / 60); ctl.render(); }
    expect(events.filter(e => e.kind === 'touch')).toEqual([]);
  });
});
