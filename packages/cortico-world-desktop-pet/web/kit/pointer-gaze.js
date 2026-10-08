/** A real-time, entry-triggered glance. Cursor observations never count as touches. */
export function createPointerGaze(seconds, clock = () => performance.now()) {
  let previous = null, inside = false, until = 0, observed = false;
  return {
    observe(p, over, source = 'move') {
      if (!p) { inside = false; previous = null; observed = true; return; }
      // Screen coordinates survive the pet window moving between displays. Previews can use local ones.
      const x = p.screenX ?? p.x, y = p.screenY ?? p.y;
      if (previous && previous.x === x && previous.y === y) return;
      const initialPoll = !observed && source === 'cursor';
      observed = true;
      previous = { x, y };
      if (!initialPoll && over && !inside) until = clock() + seconds * 1000;
      inside = over;
    },
    leave(p) {
      inside = false; observed = true;
      previous = p && Number.isFinite(p.x) && Number.isFinite(p.y)
        ? { x: p.screenX ?? p.x, y: p.screenY ?? p.y } : null;
    },
    // Losing focus/visibility cancels the glance, but does not rearm the same hover.
    suspend() { until = 0; },
    get active() { return clock() < until; },
  };
}
