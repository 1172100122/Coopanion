/**
 * One cancellable render chain. Pausing discards elapsed wall time: simulation, dialog reading,
 * and animation clocks advance only while frames are visible. No networking belongs in this loop.
 */
export function createFrameLoop({
  frame, moving, onError = () => {}, movingFps = 60, restingFps = 30,
  now = () => performance.now(), requestFrame = (cb) => requestAnimationFrame(cb),
  cancelFrame = (id) => cancelAnimationFrame(id),
  setTimer = (cb, ms) => setTimeout(cb, ms), clearTimer = (id) => clearTimeout(id),
}) {
  let active = false, disposed = false, generation = 0, raf = null, timer = null;
  let last = null, dueAt = 0, gap = 1000 / movingFps;
  const current = (epoch) => active && !disposed && epoch === generation;
  function request(epoch) {
    if (!current(epoch)) return;
    raf = requestFrame((time) => {
      if (!current(epoch)) return;
      raf = null;
      tick(time, epoch);
    });
  }
  function tick(time, epoch) {
    // Up to a quarter gap early counts as on time on displays whose refresh rate does not divide ours.
    if (time < dueAt - gap / 4) { request(epoch); return; }
    const dt = last === null ? 0 : Math.max(0, Math.min(.05, (time - last) / 1000));
    last = time;
    try { frame(dt); } catch (err) { onError(err); }
    if (!current(epoch)) return;
    const full = moving();
    gap = 1000 / (full ? movingFps : restingFps);
    dueAt = time - dueAt > gap ? time + gap : dueAt + gap;
    if (full) request(epoch);
    else timer = setTimer(() => {
      if (!current(epoch)) return;
      timer = null;
      request(epoch);
    }, Math.max(0, dueAt - gap / 4 - now()));
  }
  function setActive(on) {
    on = !!on && !disposed;
    if (active === on) return;
    active = on;
    generation++;
    if (raf !== null) cancelFrame(raf);
    if (timer !== null) clearTimer(timer);
    raf = timer = null;
    last = null; dueAt = 0; gap = 1000 / movingFps;
    if (active) request(generation);
  }
  return {
    get active() { return active; },
    setActive,
    dispose() { setActive(false); disposed = true; },
  };
}
