import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Exercise the real tray/second-instance functions without starting Electron or the Core.
const source = readFileSync(new URL('../app/main.cjs', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('async function showPet()'), source.indexOf('/**\n * Start at login.'));

describe('non-destructive pet reveal entrypoints', () => {
  it('tray show and second-instance ensure both request reveal, never stop/restart a renderer', async () => {
    const panel = vi.fn(async () => ({ connected: true }));
    const context = { panel };
    vm.createContext(context); vm.runInContext(functions, context);
    await context.showPet(); await context.ensurePet();
    expect(panel.mock.calls).toEqual([
      ['world:desktop-pet', 'pet', 'showWindow'], ['world:desktop-pet', 'pet', 'showWindow'],
    ]);
  });

  it('does not destroy hidden queues as an error fallback', async () => {
    const panel = vi.fn(async () => { throw new Error('Core disconnected'); });
    const context = { panel };
    vm.createContext(context); vm.runInContext(functions, context);
    await expect(context.showPet()).rejects.toThrow('Core disconnected');
    expect(panel).toHaveBeenCalledOnce();
  });

  it('preload exposes only a no-argument show command', () => {
    let host;
    const send = vi.fn();
    vm.runInNewContext(readFileSync(new URL('../packages/cortico-world-desktop-pet/host/preload.cjs', import.meta.url), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { host = api; } }, ipcRenderer: { send } }),
    });
    host.show(); expect(send).toHaveBeenCalledWith('pet:show');
  });
});
