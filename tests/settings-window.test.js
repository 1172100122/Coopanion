import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { SettingsWindow, SETTINGS_RECLAIM_DELAY_MS } = createRequire(import.meta.url)('../app/settings-window.cjs');

class Window extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.bounds = { x: 100, y: 80, width: options.width, height: options.height };
    this.visible = false;
    this.destroyed = false;
    this.maximized = false;
    this.minimized = false;
    this.deferClose = false;
    this.veto = false;
    this.url = '';
    this.loadCount = 0;
    this.loading = false;
    this.webContents = Object.assign(new EventEmitter(), {
      getURL: () => this.url,
      isLoading: () => this.loading,
      executeJavaScript: vi.fn(async () => true),
    });
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isMaximized() { return this.maximized; }
  getNormalBounds() { return this.bounds; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  restore() { this.minimized = false; }
  maximize() { this.maximized = true; }
  async loadURL(url) { this.url = url; this.loadCount++; }
  close() {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('close', event);
    if (event.defaultPrevented) return;
    if (!this.deferClose) this.finishClose();
  }
  finishClose() {
    if (this.veto) {
      const event = { preventDefault: vi.fn() };
      this.webContents.emit('will-prevent-unload', event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      return;
    }
    this.destroyed = true;
    this.emit('closed');
  }
}

function fixture() {
  const windows = [];
  let port = 12345;
  let quitting = false;
  const manager = new SettingsWindow({
    createWindow: (options) => { const win = new Window(options); windows.push(win); return win; },
    windowOptions: { width: 1180, height: 800, minWidth: 880, minHeight: 600 },
    consoleUrl: (path = '') => port ? `http://127.0.0.1:${port}/${path}` : null,
    loadingUrl: () => 'data:text/html,loading',
    onShow() {}, onHide() {}, configureWindow() {},
    isQuitting: () => quitting,
  });
  const open = (path) => { manager.open(path); const win = manager.window; win.emit('ready-to-show'); return win; };
  return { manager, windows, open, setPort(value) { port = value; }, quit() { quitting = true; manager.dispose(); } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const reclaim = () => vi.advanceTimersByTimeAsync(SETTINGS_RECLAIM_DELAY_MS);

describe('settings renderer reclaim', () => {
  it('keeps quick reopen in the same renderer and restores minimized windows', async () => {
    const { manager, open, windows } = fixture();
    const win = open('#/home');
    win.close();
    expect(win.isVisible()).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTINGS_RECLAIM_DELAY_MS - 1);
    win.minimized = true;
    manager.open();
    await reclaim();
    expect(windows).toHaveLength(1);
    expect(win.isDestroyed()).toBe(false);
    expect(win.isVisible()).toBe(true);
    expect(win.minimized).toBe(false);
    expect(win.loadCount).toBe(1);
  });

  it('reclaims an explicitly clean hidden page, restoring its route, bounds and maximized state', async () => {
    const { manager, windows, open } = fixture();
    const win = open();
    win.url = 'http://127.0.0.1:12345/#/usage?period=week';
    win.bounds = { x: 40, y: 60, width: 1240, height: 860 };
    win.maximized = true;
    win.close();
    await reclaim();
    expect(win.isDestroyed()).toBe(true);
    expect(manager.window).toBe(null);
    const reopened = open();
    expect(windows).toHaveLength(2);
    expect(reopened.options).toMatchObject(win.bounds);
    expect(reopened.url).toBe(win.url);
    expect(reopened.maximized).toBe(true);
  });

  it.each([false, undefined, null, 'true'])('retains dirty, unsupported or ambiguous renderer state (%s)', async (result) => {
    const { manager, open } = fixture();
    const win = open();
    win.webContents.executeJavaScript.mockResolvedValue(result);
    win.close();
    await reclaim();
    expect(manager.window).toBe(win);
    expect(win.isDestroyed()).toBe(false);
  });

  it('retains a renderer whose state cannot be queried', async () => {
    const { manager, open } = fixture();
    const win = open();
    win.webContents.executeJavaScript.mockRejectedValue(new Error('renderer gone'));
    win.close();
    await reclaim();
    expect(manager.window).toBe(win);
    expect(win.isDestroyed()).toBe(false);
  });

  it('ignores an old probe when reopened before it answers', async () => {
    const { manager, open } = fixture();
    const win = open();
    let answer;
    win.webContents.executeJavaScript.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    win.close();
    await reclaim();
    manager.open();
    answer(true);
    await Promise.resolve();
    expect(win.isDestroyed()).toBe(false);
    expect(win.isVisible()).toBe(true);
  });

  it('resets the grace period on repeated close and rejects stale probes', async () => {
    const { manager, open } = fixture();
    const win = open();
    let answer;
    win.webContents.executeJavaScript.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    win.close();
    await reclaim();
    manager.hide();
    answer(true);
    await Promise.resolve();
    expect(win.isDestroyed()).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTINGS_RECLAIM_DELAY_MS - 1);
    expect(win.isDestroyed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(win.isDestroyed()).toBe(true);
  });

  it('honors a final beforeunload veto and keeps the original renderer available', async () => {
    const { manager, windows, open } = fixture();
    const win = open();
    win.veto = true;
    win.close();
    await reclaim();
    expect(manager.closing).toBe(false);
    expect(win.isDestroyed()).toBe(false);
    open();
    expect(windows).toHaveLength(1);
    expect(win.isVisible()).toBe(true);
  });

  it.each([false, true])('reopens safely when a native close is already pending (veto=%s)', async (veto) => {
    const { manager, windows, open } = fixture();
    const win = open();
    win.deferClose = true;
    win.veto = veto;
    win.close();
    await reclaim();
    expect(manager.closing).toBe(true);
    manager.open('#/usage');
    manager.open('#/chat');
    expect(windows).toHaveLength(1);
    expect(win.isVisible()).toBe(false);
    win.finishClose();
    if (veto) {
      expect(manager.window).toBe(win);
      expect(win.isVisible()).toBe(true);
      expect(win.webContents.executeJavaScript).toHaveBeenLastCalledWith('location.hash = "#/chat"');
    } else {
      expect(windows).toHaveLength(2);
      expect(manager.window.url).toBe('http://127.0.0.1:12345/#/chat');
    }
  });

  it('does not resurrect a closed loading window and can reclaim after loading finishes', async () => {
    const { manager } = fixture();
    manager.open('#/home');
    const win = manager.window;
    win.loading = true;
    win.close();
    win.emit('ready-to-show');
    expect(win.isVisible()).toBe(false);
    await reclaim();
    expect(win.isDestroyed()).toBe(false);
    win.loading = false;
    win.webContents.emit('did-finish-load');
    await reclaim();
    expect(win.isDestroyed()).toBe(true);
  });

  it('keeps startup page requests and routes when Core changes ports', () => {
    const { manager, open, setPort } = fixture();
    setPort(null);
    const win = open('#/chat');
    expect(win.url).toBe('data:text/html,loading');
    setPort(54321);
    manager.reload();
    expect(win.url).toBe('http://127.0.0.1:54321/#/chat');
    win.url = 'http://127.0.0.1:54321/#/usage';
    setPort(12345);
    manager.reload();
    expect(win.url).toBe('http://127.0.0.1:12345/#/usage');
  });

  it('sends existing page requests through hash routing without reloading drafts', () => {
    const { manager, open } = fixture();
    const win = open('#/prompts');
    manager.open('#/dress');
    expect(win.loadCount).toBe(1);
    expect(win.webContents.executeJavaScript).toHaveBeenCalledWith('location.hash = "#/dress"');
  });

  it('never probes foreign content or destroys a window while visible or quitting', async () => {
    for (const state of ['foreign', 'visible', 'quitting']) {
      const { manager, open, quit } = fixture();
      const win = open();
      win.close();
      if (state === 'foreign') win.url = 'https://example.test/';
      if (state === 'visible') win.show();
      if (state === 'quitting') quit();
      await reclaim();
      expect(manager.window).toBe(win);
      expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
    }
  });
});
