import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { bindRenderLifecycle } = require('../packages/cortico-world-desktop-pet/host/render-lifecycle.cjs');

function windowFixture() {
  const win = new EventEmitter();
  Object.assign(win, { visible: false, minimized: false, destroyed: false,
    isVisible: () => win.visible, isMinimized: () => win.minimized, isDestroyed: () => win.destroyed,
    webContents: Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false, mainFrame: {} }),
  });
  return win;
}

afterEach(() => vi.useRealTimers());
describe('native pet visibility', () => {
  it('notifies hide/show, minimize/restore, suspend/resume, initial/reloaded pages; removes listeners', () => {
    const win = windowFixture(), powerMonitor = new EventEmitter(), onChange = vi.fn();
    const lifecycle = bindRenderLifecycle({ win, powerMonitor, onChange });
    expect(onChange).toHaveBeenLastCalledWith(false);
    win.visible = true; win.emit('show'); expect(lifecycle.active).toBe(true);
    win.emit('show'); expect(onChange).toHaveBeenCalledTimes(2);
    win.minimized = true; win.emit('minimize'); expect(lifecycle.active).toBe(false);
    win.minimized = false; win.emit('restore'); expect(lifecycle.active).toBe(true);
    powerMonitor.emit('suspend'); expect(lifecycle.active).toBe(false);
    win.emit('show'); expect(lifecycle.active).toBe(false);
    powerMonitor.emit('resume'); expect(lifecycle.active).toBe(true);
    win.visible = false; win.emit('hide'); powerMonitor.emit('suspend'); powerMonitor.emit('resume');
    expect(lifecycle.active).toBe(false);
    const n = onChange.mock.calls.length;
    win.webContents.emit('did-finish-load'); expect(onChange).toHaveBeenCalledTimes(n + 1);
    expect(win.webContents.send).toHaveBeenLastCalledWith('pet:render-state', { active: false });
    lifecycle.dispose(); lifecycle.dispose(); expect(powerMonitor.listenerCount('resume')).toBe(0);
    expect(win.listenerCount('show')).toBe(0); expect(win.webContents.listenerCount('did-finish-load')).toBe(0);
  });

  it('actually stops native cursor intervals while hidden/suspended and reports a stationary cursor on resume', async () => {
    vi.useFakeTimers();
    const windows = [], app = Object.assign(new EventEmitter(), { whenReady: () => Promise.resolve(), quit: vi.fn() });
    const ipcMain = Object.assign(new EventEmitter(), { handle: vi.fn() }), powerMonitor = new EventEmitter();
    const display = { id: 1, workArea: { x: 0, y: 0, width: 900, height: 600 }, bounds: { x: 0, y: 0, width: 900, height: 600 } };
    const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display,
      getCursorScreenPoint: vi.fn(() => ({ x: 200, y: 300 })),
    });
    function BrowserWindow() {
      const win = windowFixture(); windows.push(win);
      Object.assign(win, { setBounds: vi.fn(), getBounds: () => display.bounds, setAlwaysOnTop: vi.fn(),
        setIgnoreMouseEvents: vi.fn(), loadURL: vi.fn(), showInactive: () => { win.visible = true; win.emit('show'); },
        hide: () => { win.visible = false; win.emit('hide'); },
        restore: () => { win.minimized = false; win.emit('restore'); },
      });
      win.webContents.setWindowOpenHandler = vi.fn();
      return win;
    }
    const electron = { app, BrowserWindow, ipcMain, powerMonitor, screen,
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    };
    const file = fileURLToPath(new URL('../packages/cortico-world-desktop-pet/host/electron-main.cjs', import.meta.url));
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(file, 'utf8'), { module, exports: module.exports,
      require: name => name === 'electron' ? electron : name === './render-lifecycle.cjs' ? { bindRenderLifecycle } : require(name),
      __dirname: dirname(file), __filename: file, process: { platform: 'linux', argv: [] }, URL, console,
      setInterval, clearInterval, Buffer,
    });
    module.exports.runPetHost({ url: 'http://localhost:8000/pet', tray: false });
    await Promise.resolve();
    const win = windows[0]; expect(vi.getTimerCount()).toBe(0);
    win.showInactive(); expect(screen.getCursorScreenPoint).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(1000);
    expect(screen.getCursorScreenPoint).toHaveBeenCalledTimes(11);
    win.hide(); expect(vi.getTimerCount()).toBe(0); vi.advanceTimersByTime(1000);
    expect(screen.getCursorScreenPoint).toHaveBeenCalledTimes(11);
    ipcMain.emit('pet:show', { sender: {}, senderFrame: win.webContents.mainFrame });
    ipcMain.emit('pet:show', { sender: win.webContents, senderFrame: {} });
    expect(win.visible).toBe(false); expect(vi.getTimerCount()).toBe(0);
    ipcMain.emit('pet:show', { sender: win.webContents, senderFrame: win.webContents.mainFrame });
    expect(win.visible).toBe(true); expect(windows).toHaveLength(1); expect(win.loadURL).toHaveBeenCalledOnce();
    expect(screen.getCursorScreenPoint).toHaveBeenCalledTimes(12);
    expect(win.webContents.send).toHaveBeenLastCalledWith('pet:cursor', { x: 200, y: 300, screenX: 200, screenY: 300 });
    powerMonitor.emit('suspend'); expect(vi.getTimerCount()).toBe(0);
    powerMonitor.emit('resume'); expect(vi.getTimerCount()).toBe(1);
    win.minimized = true; win.emit('minimize'); expect(vi.getTimerCount()).toBe(0);
    ipcMain.emit('pet:show', { sender: win.webContents, senderFrame: win.webContents.mainFrame });
    expect(win.minimized).toBe(false); expect(vi.getTimerCount()).toBe(1);
    win.destroyed = true; win.emit('closed'); expect(vi.getTimerCount()).toBe(0);
    expect(powerMonitor.listenerCount('resume')).toBe(0);
  });
});
