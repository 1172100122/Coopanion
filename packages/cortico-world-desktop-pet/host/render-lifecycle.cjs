/**
 * Native visibility is authoritative with backgroundThrottling:false. Pause only visual work;
 * the World, sockets, reminder delivery, and fullscreen wake detection remain independent.
 */
function bindRenderLifecycle({ win, powerMonitor, onChange }) {
  let suspended = false, active = null, disposed = false;
  function refresh(force = false) {
    if (disposed || win.isDestroyed()) return;
    const next = !suspended && win.isVisible() && !win.isMinimized();
    if (next !== active || force) {
      active = next;
      // Send before cursor sampling so a freshly shown renderer resets its gaze before the sample.
      if (!win.webContents.isDestroyed()) win.webContents.send('pet:render-state', { active });
      onChange(active);
    }
  }
  const visibility = () => refresh();
  const loaded = () => refresh(true);
  const suspend = () => { suspended = true; refresh(); };
  const resume = () => { suspended = false; refresh(); };
  for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, visibility);
  win.webContents.on('did-finish-load', loaded);
  powerMonitor.on('suspend', suspend);
  powerMonitor.on('resume', resume);
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const event of ['show', 'hide', 'minimize', 'restore']) win.removeListener(event, visibility);
    win.webContents.removeListener('did-finish-load', loaded);
    powerMonitor.removeListener('suspend', suspend);
    powerMonitor.removeListener('resume', resume);
    onChange(false);
  }
  refresh();
  return { refresh, dispose, get active() { return active === true && !disposed; } };
}

module.exports = { bindRenderLifecycle };
