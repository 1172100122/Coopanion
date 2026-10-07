/** Approved Hachimist sprite atlas, drawn by the normal sandboxed figure kit. */
const SVGNS = 'http://www.w3.org/2000/svg';
export const ATLAS = Object.freeze({ width: 1536, height: 2288, cellWidth: 192, cellHeight: 208 });
export const STATES = Object.freeze({
  idle: { row: 0, frames: 6, fps: 6 },
  'running-right': { row: 1, frames: 8, fps: 12 },
  'running-left': { row: 2, frames: 8, fps: 12 },
  waving: { row: 3, frames: 4, fps: 6 },
  jumping: { row: 4, frames: 5, fps: 8 },
  failed: { row: 5, frames: 8, fps: 6 },
  waiting: { row: 6, frames: 6, fps: 5 },
  running: { row: 7, frames: 6, fps: 6 },
  review: { row: 8, frames: 6, fps: 6 },
});

/** The atlas's look direction is clockwise from up; the kit's gaze is in local body coordinates. */
export function lookCell([x, y]) {
  const angle = (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2);
  const index = Math.round(angle / (Math.PI / 8)) % 16;
  return { row: 9 + Math.floor(index / 8), column: index % 8 };
}

/** Physical modes take priority over expressions, and expressions over idle pointer tracking. */
export function spriteState(frame) {
  if (frame.mode === 'sleep') return 'sleep';
  if (frame.mode === 'crouch' || frame.mode === 'air' || frame.mode === 'land') return 'jumping';
  if (frame.mode === 'drag' || frame.mode === 'dizzy') return 'failed';
  if (frame.mode === 'walk' || frame.mode === 'run') return frame.facing < 0 ? 'running-left' : 'running-right';
  if (frame.face === 'sleepy') return 'sleep';
  if (frame.gesture?.kind === 'wave') return 'waving';
  if (frame.face === 'listening') return 'waiting';
  if (frame.face === 'thinking') return 'running';
  if (frame.face === 'sad' || frame.face === 'worried' || frame.face === 'cry') return 'failed';
  if (frame.face === 'happy' || frame.face === 'love' || frame.face === 'excited') return 'review';
  if (frame.mode === 'look' || Math.hypot(...(frame.look ?? [0, 0])) > 2) return 'look';
  return 'idle';
}

export function spriteCell(state, frame, elapsed) {
  if (state === 'sleep') return { row: 0, column: 2 };
  if (state === 'look') return lookCell(frame.look ?? [0, -1]);
  const strip = STATES[state] ?? STATES.idle;
  let column = Math.floor(Math.max(0, elapsed) * strip.fps) % strip.frames;
  // The physics provides height; choose the existing takeoff/apex/landing poses without a second jump loop.
  if (state === 'jumping') column = frame.mode === 'crouch' ? 0 : frame.mode === 'land' ? 4 : Math.min(3, 1 + Math.floor(frame.modeT * 6));
  return { row: strip.row, column };
}

export async function createHachimistFigure(base, { loadImage, asset }) {
  const url = asset('spritesheet.png');
  const image = await loadImage(url);
  if (image.naturalWidth !== ATLAS.width || image.naturalHeight !== ATLAS.height) {
    throw new Error('Hachimist sprite atlas must be 1536 × 2288');
  }
  let viewport = null, picture = null, previousState = '', startedAt = 0, previousCell = '';
  return {
    colors: { z: '#A67BBD' },
    // Includes the baked-in jump's highest frame, so effects and hit testing stay inside the art's extent.
    extent: [29, -42, 227, 256],
    hits: [[128, 112, 57], [128, 202, 52]],
    anchors: { gaze: [128, 111], bubble: [128, 27], z: [182, 40], hearts: [94, 166, 55], tear: [148, 123] },
    gestures: ['wave'],
    draw(petG, face, frame) {
      if (!viewport || viewport.parentNode !== petG) {
        previousCell = '';
        previousState = '';
        const doc = petG.ownerDocument;
        viewport = doc.createElementNS(SVGNS, 'svg');
        viewport.setAttribute('x', '-16');
        viewport.setAttribute('y', '-48.5');
        viewport.setAttribute('width', '288');
        viewport.setAttribute('height', '312');
        viewport.setAttribute('overflow', 'hidden');
        picture = doc.createElementNS(SVGNS, 'image');
        picture.setAttribute('href', String(url));
        picture.setAttribute('width', String(ATLAS.width));
        picture.setAttribute('height', String(ATLAS.height));
        viewport.appendChild(picture);
        petG.appendChild(viewport);
      }
      const state = spriteState(frame);
      if (state !== previousState) { previousState = state; startedAt = frame.t; }
      const cell = spriteCell(state, frame, frame.t - startedAt);
      const key = `${cell.row}:${cell.column}`;
      if (key !== previousCell) {
        viewport.setAttribute('viewBox', `${cell.column * ATLAS.cellWidth} ${cell.row * ATLAS.cellHeight} ${ATLAS.cellWidth} ${ATLAS.cellHeight}`);
        viewport.dataset.frame = String(cell.column);
        previousCell = key;
      }
      viewport.dataset.state = state;
      // The left-running art already faces left. Cancel the kit's mirror for that row only.
      viewport.setAttribute('transform', state === 'running-left' ? 'translate(256 0) scale(-1 1)' : '');
    },
    dispose() { viewport?.remove(); viewport = null; picture = null; },
  };
}

export async function createHachimistBody(base, opts) {
  return opts.kit.createBody(opts.host, { figure: await createHachimistFigure(base, opts) });
}
