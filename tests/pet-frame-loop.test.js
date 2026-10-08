import { describe, expect, it, vi } from 'vitest';
import { createFrameLoop } from '../packages/cortico-world-desktop-pet/web/frame-loop.js';

function fixture(moving = false) {
  let time = 0, id = 0;
  const rafs = new Map(), timers = new Map(), dt = [];
  const cancelFrame = vi.fn(n => rafs.delete(n)), clearTimer = vi.fn(n => timers.delete(n));
  const loop = createFrameLoop({ frame: n => dt.push(n), moving: () => moving, now: () => time,
    requestFrame: cb => { rafs.set(++id, cb); return id; }, cancelFrame,
    setTimer: cb => { timers.set(++id, cb); return id; }, clearTimer,
  });
  function frame(at) { time = at; const [n, cb] = rafs.entries().next().value; rafs.delete(n); cb(time); }
  function timer() { const [n, cb] = timers.entries().next().value; timers.delete(n); cb(); }
  return { loop, rafs, timers, dt, frame, timer, cancelFrame, clearTimer };
}

describe('pet render scheduler', () => {
  it('starts only when active, idempotently; resting frames use a cancellable timer', () => {
    const f = fixture(); expect(f.rafs.size).toBe(0);
    f.loop.setActive(true); f.loop.setActive(true); expect(f.rafs.size).toBe(1);
    f.frame(100); expect(f.dt).toEqual([0]); expect(f.timers.size).toBe(1);
    f.loop.setActive(false); expect(f.timers.size).toBe(0); expect(f.clearTimer).toHaveBeenCalledOnce();
    f.loop.setActive(false); expect(f.clearTimer).toHaveBeenCalledOnce();
  });
  it('cancels pending animation frames and ignores stale callbacks after rapid hide/show', () => {
    const f = fixture(true);
    f.loop.setActive(true); const stale = [...f.rafs.values()][0];
    f.loop.setActive(false); f.loop.setActive(true);
    stale(1000); expect(f.dt).toEqual([]); expect(f.rafs.size).toBe(1);
    f.frame(1000); expect(f.dt).toEqual([0]); expect(f.rafs.size).toBe(1);
    f.loop.dispose(); expect(f.rafs.size).toBe(0);
    f.loop.setActive(true); expect(f.rafs.size).toBe(0);
  });
  it('ignores a cancelled timer even after resume and discards the hidden elapsed time', () => {
    const f = fixture(); f.loop.setActive(true); f.frame(100);
    const stale = [...f.timers.values()][0];
    f.timer(); f.frame(134); expect(f.dt.at(-1)).toBeCloseTo(.034);
    f.loop.setActive(false); f.loop.setActive(true); stale();
    expect(f.rafs.size).toBe(1); f.frame(100_000); expect(f.dt.at(-1)).toBe(0);
    f.timer(); f.frame(100_034); expect(f.dt.at(-1)).toBeCloseTo(.034);
  });
  it('does not restart itself when paused during the frame and keeps surviving frame errors', () => {
    let loop, fail = true; const rafs = [], errors = [];
    loop = createFrameLoop({ frame: () => { if (fail) throw new Error('draw'); loop.setActive(false); },
      moving: () => true, onError: err => errors.push(err.message),
      requestFrame: cb => { rafs.push(cb); return rafs.length; }, cancelFrame() {},
    });
    loop.setActive(true); rafs.shift()(100); expect(errors).toEqual(['draw']); expect(rafs.length).toBe(1);
    fail = false; rafs.shift()(134); expect(loop.active).toBe(false); expect(rafs.length).toBe(0);
  });
});
