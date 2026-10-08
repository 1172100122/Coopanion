import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { loadBody } from '../packages/cortico-world-desktop-pet/web/body-host.js';
import { createBody } from '../packages/cortico-world-desktop-pet/web/kit/body.js';
import { cooFigure, defaultSkin } from '../packages/cortico-world-desktop-pet/web/coo/coo.js';

describe('paint-bounded halo', () => {
  it('preserves both halo radii and all painted layers without filtering the full stage', () => {
    const dom = new JSDOM('<div id="root"></div>');
    const root = dom.window.document.querySelector('#root');
    const body = createBody({ root, bounds: () => ({ W: 1364, H: 936, floorY: 934, S: .42 }), start: { skin: defaultSkin() }, emit() {}, sound() {} }, { figure: cooFigure() });
    body.step(1 / 30); body.setHalo(.5);
    const svg = root.querySelector('svg.kit'), group = svg.querySelector('.kit-halo');
    expect(group.parentElement).toBe(svg);
    expect(group.children).toHaveLength(3);
    expect(group.getAttribute('transform')).toBeNull();
    expect(svg.style.filter).toBe('');
    expect(group.style.filter).toBe('drop-shadow(0 0 3px rgba(184,184,184,0.50)) drop-shadow(0 0 7px rgba(184,184,184,0.50))');
    body.setHalo(0); expect(group.style.filter).toBe('');
    body.dispose(); expect(root.children).toHaveLength(0);
    dom.window.close();
  });
  for (const localHalo of [false, true]) it(`uses ${localHalo ? 'pack-local' : 'legacy iframe'} filtering and only sends changed opacity`, async () => {
    const dom = new JSDOM('<div id="layer"></div>', { url: 'http://localhost/' });
    const { window } = dom;
    vi.stubGlobal('document', window.document); vi.stubGlobal('location', window.location);
    vi.stubGlobal('addEventListener', window.addEventListener.bind(window));
    vi.stubGlobal('removeEventListener', window.removeEventListener.bind(window));
    let body;
    try {
      const loading = loadBody({ layer: window.document.querySelector('#layer'), pack: { id: 'test' }, start: {}, bounds: { W: 900, H: 500, S: .42 } });
      const iframe = window.document.querySelector('iframe'), sent = [];
      vi.spyOn(iframe.contentWindow, 'postMessage').mockImplementation(m => sent.push(m));
      window.dispatchEvent(new window.MessageEvent('message', { source: iframe.contentWindow, data: { t: 'ready', localHalo } }));
      body = await loading;
      body.setHalo(.498); body.setHalo(.499); body.setHalo(.5);
      if (localHalo) {
        expect(sent).toEqual([{ t: 'halo', k: .5 }]); expect(iframe.style.filter).toBe('');
        body.setHalo(0); expect(sent.at(-1)).toEqual({ t: 'halo', k: 0 });
      } else { expect(sent).toEqual([]); expect(iframe.style.filter).toContain('drop-shadow'); body.setHalo(0); expect(iframe.style.filter).toBe(''); }
    } finally { body?.dispose(); vi.unstubAllGlobals(); window.close(); }
  });
});
