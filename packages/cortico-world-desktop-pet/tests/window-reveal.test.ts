import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { DesktopPetWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FakePage } from './helpers/page.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
  const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
  Object.assign(cfg, { enabled: true, port: 0 }); cfg.window.enabled = false; cfg.asr.enabled = false;
  const dir = mkdtempSync(join(tmpdir(), 'pet-reveal-'));
  const world = new DesktopPetWorld({ cfg, timezone: 'Etc/UTC', persist() {},
    runtimesRoot: () => join(dir, 'runtimes'), modelsDir: () => join(dir, 'models'),
  });
  const host = new FakeHost();
  await world.start(host); cleanup.push(() => world.stop());
  // Revealing a connected pet must not launch or stop a process. For missing windows, observe launch intent only.
  const open = vi.spyOn(world, 'openWindow').mockImplementation(() => {});
  const connect = async (query = 'role=pet&host=window') => {
    const page = await FakePage.open(world.petUrl.replace(/\/pet$/, ''), query);
    cleanup.push(() => page.close()); return page;
  };
  const reveal = () => world.console().invoke!('pet', 'showWindow', []);
  return { world, host, open, connect, reveal };
}

describe('native window reveal', () => {
  it('reveals a connected native page repeatedly without disconnecting it or spawning another host', async () => {
    const f = await fixture(), page = await f.connect();
    await f.world.tools().find(t => t.name === 'pet_ask')!.handler({ question: 'Keep this?', options: ['Yes'] }, { role: 'main', log: f.host.log });
    const question = await page.next(m => m.t === 'ask');
    await f.reveal(); expect(await page.next(m => m.t === 'show-window')).toEqual({ t: 'show-window' });
    await f.reveal(); expect(await page.next(m => m.t === 'show-window')).toEqual({ t: 'show-window' });
    expect(f.open).not.toHaveBeenCalled(); expect(page.closeCode).toBeNull();
    expect(f.world.petState().connected).toBe(true);
    page.send({ t: 'answer', askId: question.id, index: 0 });
    await expect.poll(() => f.host.events.length).toBe(1);
    expect(f.host.events[0].type).toBe('desktop-pet.answer');
  });

  it('starts a missing window and retains the reveal until its native page connects', async () => {
    const f = await fixture();
    await f.reveal(); expect(f.open).toHaveBeenCalledOnce();
    const page = await f.connect(); expect(await page.next(m => m.t === 'show-window')).toEqual({ t: 'show-window' });
    expect(f.open).toHaveBeenCalledOnce();
  });

  it('does not mistake a live browser tab for a native window or send its pending reveal there', async () => {
    const f = await fixture(), tab = await f.connect('role=pet&host=tab');
    await f.reveal(); expect(f.open).toHaveBeenCalledOnce();
    expect(tab.messages.some(m => m.t === 'show-window')).toBe(false);
    const native = await f.connect(); expect(await native.next(m => m.t === 'show-window')).toEqual({ t: 'show-window' });
    const watcher = await f.connect('role=pet&host=tab');
    await f.reveal(); await native.next(m => m.t === 'show-window');
    expect(watcher.messages.some(m => m.t === 'show-window')).toBe(false);
    expect(f.open).toHaveBeenCalledOnce();
  });

  it('cancels an outstanding reveal when the user explicitly closes the window', async () => {
    const f = await fixture(); await f.reveal();
    await f.world.console().invoke!('pet', 'closeWindow', []);
    const page = await f.connect();
    expect(page.messages.some(m => m.t === 'show-window')).toBe(false);
  });
});
