/** Hidden, untouched console pages can release their renderer after a short reopen grace period. */
const SETTINGS_RECLAIM_DELAY_MS = 30_000;
const CAN_RECLAIM = 'window.__coopanionSettingsLifecycle?.canReclaim() === true';

class SettingsWindow {
  constructor({ createWindow, windowOptions, consoleUrl, loadingUrl, onShow, onHide, isQuitting, configureWindow, delayMs = SETTINGS_RECLAIM_DELAY_MS }) {
    Object.assign(this, { createWindow, windowOptions, consoleUrl, loadingUrl, onShow, onHide, isQuitting, configureWindow, delayMs });
    this.window = null;
    this.path = '';
    this.bounds = null;
    this.maximized = false;
    this.loadedOrigin = null;
    this.timer = null;
    this.generation = 0;
    this.wanted = false;
    this.closing = false;
    this.pendingPath = '';
  }

  cancelReclaim() {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  remember(win) {
    if (win.isDestroyed()) return;
    this.bounds = win.getNormalBounds();
    this.maximized = win.isMaximized();
    try {
      const url = new URL(win.webContents.getURL());
      if (url.origin === this.loadedOrigin) this.path = `${url.pathname.slice(1)}${url.search}${url.hash}`;
    } catch { /* The loading page has no console route. */ }
  }

  load(win, path) {
    this.path = path;
    const url = this.consoleUrl(path);
    this.loadedOrigin = url ? new URL(url).origin : null;
    void win.loadURL(url ?? this.loadingUrl()).catch(() => { /* A canceled navigation keeps the existing page. */ });
  }

  open(path = '') {
    this.cancelReclaim();
    this.wanted = true;
    this.onShow();
    // A native close already sent to Chromium cannot be canceled synchronously. Reopen after
    // it finishes (or its final beforeunload check vetoes it), instead of showing a dying window.
    if (this.closing) { this.pendingPath = path; return; }
    const current = this.window;
    if (current && !current.isDestroyed()) {
      if (current.isMinimized()) current.restore();
      current.show();
      current.focus();
      if (path) {
        // Core's page requests are hash routes. Let the router's unsaved-edit confirmation run.
        if (path.startsWith('#') && this.loadedOrigin) {
          void current.webContents.executeJavaScript(`location.hash = ${JSON.stringify(path)}`).catch(() => {});
        } else this.load(current, path);
      }
      return;
    }
    const win = this.createWindow({ ...this.windowOptions, ...(this.bounds ?? {}) });
    this.window = win;
    win.once('ready-to-show', () => {
      if (this.window !== win || win.isDestroyed() || !this.wanted) return;
      if (this.maximized) win.maximize();
      win.show();
    });
    win.on('close', (event) => {
      if (this.isQuitting()) { this.cancelReclaim(); return; }
      if (this.closing) return;
      event.preventDefault();
      this.hide();
    });
    win.on('closed', () => {
      if (this.window !== win) return;
      this.cancelReclaim();
      this.window = null;
      this.closing = false;
      if (this.wanted && !this.isQuitting()) {
        const path = this.pendingPath;
        this.pendingPath = '';
        this.open(path);
      }
    });
    win.webContents.on('will-prevent-unload', () => {
      // Never override the renderer's veto, including edits made while the probe was in flight.
      if (this.window !== win || !this.closing) return;
      this.closing = false;
      if (this.wanted && !this.isQuitting()) {
        const path = this.pendingPath;
        this.pendingPath = '';
        this.open(path);
      }
    });
    win.webContents.on('did-finish-load', () => {
      if (this.window === win && !this.wanted && !this.closing) this.scheduleReclaim(win);
    });
    this.configureWindow(win);
    this.load(win, path || this.path);
  }

  hide() {
    this.cancelReclaim();
    this.wanted = false;
    this.pendingPath = '';
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    this.remember(win);
    win.hide();
    this.onHide();
    if (this.closing) return;
    this.scheduleReclaim(win);
  }

  scheduleReclaim(win) {
    this.cancelReclaim();
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reclaim(win, generation);
    }, this.delayMs);
  }

  async reclaim(win, generation) {
    const eligible = () => this.window === win && this.generation === generation && !this.wanted
      && !this.isQuitting() && !win.isDestroyed() && !win.isVisible() && !win.webContents.isLoading();
    if (!eligible() || !this.loadedOrigin) return;
    try {
      if (new URL(win.webContents.getURL()).origin !== this.loadedOrigin) return;
      const clean = await win.webContents.executeJavaScript(CAN_RECLAIM);
      if (clean !== true || !eligible()) return;
      this.remember(win);
      this.closing = true;
      // close(), never destroy(): beforeunload must get the final say on unsaved state.
      win.close();
    } catch {
      // A superseded probe must not reset a newer native close already in flight.
      if (this.window === win && this.generation === generation) this.closing = false;
    }
  }

  reload() {
    const win = this.window;
    if (!win || win.isDestroyed() || this.closing) return;
    this.remember(win);
    this.load(win, this.path);
  }

  dispose() { this.cancelReclaim(); }
}

module.exports = { SettingsWindow, SETTINGS_RECLAIM_DELAY_MS };
