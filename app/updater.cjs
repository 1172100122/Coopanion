/**
 * Updates from the GitHub releases (electron-updater), where they can install themselves: the Windows
 * installer and the Linux AppImage. A macOS build is signed ad hoc, which Squirrel.Mac refuses to
 * install, and a deb belongs to the package manager; there the settings window's version line still
 * says when a release is out.
 *
 * A newer release downloads in the background. Each step is handed to the Core (`tell`), which says
 * it in Coo's bubble with a way to the releases page, since a download from GitHub can crawl: found
 * and downloading, downloaded (restart now, or it installs when the app quits), or failed. What the
 * updater does is written to `updater.log` in the logs directory.
 */
const { app } = require('electron');
const { createWriteStream, mkdirSync } = require('node:fs');
const { join } = require('node:path');

// This customization has no signed release channel. Upstream updates would replace its character.
const AUTO_UPDATES_ENABLED = false;
const RELEASES_URL = 'https://github.com/Pal-AI-Lab/Coopanion/releases/latest';
/** Releases come out at most a few times a day; a run left open for days still hears of them the same day. */
const CHECK_EVERY_MS = 6 * 3600_000;

/** Whether this build can install an update by itself. */
function canUpdate() {
  return AUTO_UPDATES_ENABLED && app.isPackaged && (process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE));
}

/**
 * Starts checking. `tell({ phase: 'downloading' | 'ready' | 'failed', version, reason? })` reports each
 * step. Returns `installOnQuit()`, true when a downloaded update was started for installing as the app
 * quits, and `installNow()`.
 */
function startUpdater({ logDir, tell }) {
  if (!canUpdate()) return { installOnQuit: () => false, installNow: () => {} };
  const { autoUpdater } = require('electron-updater');
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(join(logDir, 'updater.log'), { flags: 'a' });
  const line = (level) => (...args) => log.write(`${new Date().toISOString()} ${level} ${args.map(String).join(' ')}\n`);
  autoUpdater.logger = { info: line('info'), warn: line('warn'), error: line('error'), debug: line('debug') };
  autoUpdater.autoDownload = true;
  // the app's own quit stops the Core first and then exits, which skips the quit event the updater waits for: installOnQuit does it
  autoUpdater.autoInstallOnAppQuit = false;

  let downloading = null;
  let ready = null;
  autoUpdater.on('update-available', (info) => {
    if (downloading === info.version || ready === info.version) return;
    downloading = info.version;
    tell({ phase: 'downloading', version: info.version });
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloading = null;
    if (ready === info.version) return;
    ready = info.version;
    tell({ phase: 'ready', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    // a failed check (no network, GitHub out of reach) is only logged; a download that was under way is told
    if (!downloading) return;
    tell({ phase: 'failed', version: downloading, reason: String(err?.message ?? err).split('\n')[0].slice(0, 200) });
    downloading = null;
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => { /* logged by the updater */ });
  check();
  setInterval(check, CHECK_EVERY_MS).unref();

  return {
    installOnQuit() {
      if (!ready) return false;
      ready = null;
      autoUpdater.quitAndInstall(true, false);
      return true;
    },
    // the quit this starts comes back through installOnQuit, which then has nothing left to install
    installNow() {
      if (!ready) return;
      ready = null;
      autoUpdater.quitAndInstall(true, true);
    },
  };
}

module.exports = { startUpdater, RELEASES_URL };
