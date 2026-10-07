import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createPreviewServer } from '../packages/cortico-world-desktop-pet/examples/hachimist/serve.mjs';
import { describe, expect, it } from 'vitest';
import * as kit from '../packages/cortico-world-desktop-pet/web/kit/body.js';
import { ATLAS, STATES, createHachimistBody, createHachimistFigure, lookCell, spriteCell, spriteState } from '../packages/cortico-world-desktop-pet/web/hachimist/figure.js';
import { DESKTOP_PET_DEFAULTS } from '../packages/cortico-world-desktop-pet/src/config.ts';
import { normalizeSkin } from '../packages/cortico-world-desktop-pet/web/coo/coo.js';
import { figurePacks, packFor, readManifest } from '../packages/cortico-world-desktop-pet/src/packs.ts';

const dir = new URL('../packages/cortico-world-desktop-pet/web/hachimist/', import.meta.url);
const opts = () => ({ loadImage: async () => ({ naturalWidth: ATLAS.width, naturalHeight: ATLAS.height }), asset: (p) => new URL(p, dir) });
const frame = (changes = {}) => ({ mode: 'idle', face: 'neutral', modeT: 0, t: 0, facing: 1, look: [0, 0], ...changes });

describe('Hachimist figure', () => {
  it('ships the exact approved 73-frame atlas with nine animation states and 16 look directions', () => {
    expect(createHash('sha256').update(readFileSync(new URL('spritesheet.png', dir))).digest('hex')).toBe('b5f9ac315bcb201a23e38e8235f30af0f1a9c7b7504ebacd07822a9b62c49536');
    expect(Object.values(STATES).reduce((sum, row) => sum + row.frames, 16)).toBe(73);
    expect(Object.keys(STATES)).toHaveLength(9);
  });
  it('defaults new installs to Hachimist while preserving saved figures and Coo fallback', () => {
    const { packs, problems } = figurePacks([]);
    expect(problems).toEqual([]);
    expect(packFor(packs, DESKTOP_PET_DEFAULTS.skin.figure).id).toBe('hachimist');
    expect(packFor(packs, 'missing').id).toBe('coo');
    expect(normalizeSkin({ figure: 'coo', palette: 'fox' })).toMatchObject({ figure: 'coo', palette: 'fox' });
  });
  it('maps all look directions clockwise from up without selecting empty atlas cells', () => {
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      expect(lookCell([Math.sin(a), -Math.cos(a)])).toEqual({ row: 9 + Math.floor(i / 8), column: i % 8 });
    }
    for (const [state, strip] of Object.entries(STATES)) {
      for (let t = 0; t < 4; t += .017) expect(spriteCell(state, frame(), t).column).toBeLessThan(strip.frames);
    }
  });
  it('prioritizes physical movement and uses honest existing-art fallbacks', () => {
    expect(spriteState(frame({ mode: 'walk', facing: -1, face: 'happy' }))).toBe('running-left');
    expect(spriteState(frame({ mode: 'run', facing: 1 }))).toBe('running-right');
    expect(spriteState(frame({ mode: 'air', face: 'sleepy' }))).toBe('jumping');
    expect(spriteState(frame({ mode: 'walk', face: 'sleepy' }))).toBe('running-right');
    expect(spriteState(frame({ gesture: { kind: 'wave', k: .4 } }))).toBe('waving');
    expect(spriteState(frame({ face: 'listening' }))).toBe('waiting');
    expect(spriteState(frame({ face: 'thinking' }))).toBe('running');
    expect(spriteState(frame({ face: 'sad' }))).toBe('failed');
    expect(spriteState(frame({ face: 'happy' }))).toBe('review');
    expect(spriteCell('sleep', frame(), 10)).toEqual({ row: 0, column: 2 });
    expect(spriteState(frame({ face: 'unknown' }))).toBe('idle');
  });
  it('renders one reusable cropped viewport, advances frames, corrects left mirroring and disposes', async () => {
    const dom = new JSDOM('<svg><g/></svg>');
    const group = dom.window.document.querySelector('g');
    const figure = await createHachimistFigure(dir, opts());
    figure.draw(group, {}, frame());
    figure.draw(group, {}, frame({ t: .4 }));
    expect(group.children).toHaveLength(1);
    expect(group.firstChild.getAttribute('viewBox')).toBe('384 0 192 208');
    figure.draw(group, {}, frame({ mode: 'walk', facing: -1, t: 1 }));
    expect(group.firstChild.getAttribute('viewBox')).toBe('0 416 192 208');
    expect(group.firstChild.getAttribute('transform')).toBe('translate(256 0) scale(-1 1)');
    figure.dispose();
    expect(group.children).toHaveLength(0);
    figure.draw(group, {}, frame({ mode: 'walk', facing: -1, t: 2 }));
    expect(group.firstChild.getAttribute('viewBox')).toBe('0 416 192 208');
    figure.dispose();
  });
  it('rejects a wrong-sized atlas so the host can fall back safely', async () => {
    await expect(createHachimistFigure(dir, { ...opts(), loadImage: async () => ({ naturalWidth: 1, naturalHeight: 1 }) })).rejects.toThrow('1536');
  });
  it('runs every advertised action through the real kit and keeps walking, interrupted motion and repeated disposal working', async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const root = dom.window.document.querySelector('#root');
    const events = [];
    const manifest = readManifest(fileURLToPath(dir), true);
    const body = await createHachimistBody(dir, { ...opts(), kit, host: { root, bounds: () => ({ W: 900, H: 400, floorY: 350, S: .8 }), emit: (kind, detail) => events.push({ kind, detail }), sound() {} } });
    body.set({ roam: 'off' });
    for (const word of manifest.vocab) {
      expect(body.do(word.id), word.id).toBe(true);
      for (let i = 0; i < 360; i++) body.step(1 / 60);
      expect(Number.isFinite(body.layout().x)).toBe(true);
    }
    body.do('stand'); body.step(.1);
    expect(body.walk(120, false, 1)).toBe(true);
    body.step(.2); body.do('turn'); body.step(.1);
    expect(events.some((e) => e.kind === 'interrupted' && e.detail.walkId === 1)).toBe(true);
    body.dispose(); body.dispose();
    expect(root.children).toHaveLength(0);
  });
});


describe('Hachimist local preview', () => {
  it('serves the real sandbox and atlas, preserves its network restrictions, and rejects invalid paths', async () => {
    const server = createPreviewServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const page = await fetch(base);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Hachimist');
      const sandbox = await fetch(`${base}/figure-frame`);
      expect(sandbox.status).toBe(200);
      expect(sandbox.headers.get('content-security-policy')).toContain("connect-src 'none'");
      expect(sandbox.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      const atlas = await fetch(`${base}/web/hachimist/spritesheet.png`);
      expect(atlas.status).toBe(200);
      expect(atlas.headers.get('content-type')).toBe('image/png');
      expect(createHash('sha256').update(Buffer.from(await atlas.arrayBuffer())).digest('hex')).toBe('b5f9ac315bcb201a23e38e8235f30af0f1a9c7b7504ebacd07822a9b62c49536');
      expect((await fetch(`${base}/%ZZ`)).status).toBe(400);
      expect((await fetch(`${base}/..%2F..%2Fpackage.json`)).status).toBe(403);
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  });
});
