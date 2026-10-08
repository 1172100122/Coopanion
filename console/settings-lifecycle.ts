/** Reclaim is opt-in: unknown pages, embedded editors and any edited session stay in memory. */
const SAFE_ROUTES = new Set(['home', 'pet', 'voice', 'cua', 'usage', 'chat', 'live', 'prompts']);

interface ReclaimState {
  ready(): boolean;
  route(): string | undefined;
  router: {
    addLeaveGuard(guard: () => string | null): { dispose(): void };
    addLeaveDecision(decide: () => Promise<boolean>): { dispose(): void };
  };
}

export function installSettingsLifecycle(doc: Document, state: ReclaimState): { dispose(): void } {
  const win = doc.defaultView;
  if (!win) return { dispose() {} };
  let edited = false;
  const guards = new Set<() => string | null>();
  const decisions = new Set<() => Promise<boolean>>();
  const { router } = state;
  const addGuard = router.addLeaveGuard;
  const addDecision = router.addLeaveDecision;
  router.addLeaveGuard = (guard) => {
    guards.add(guard);
    const subscription = addGuard.call(router, guard);
    return { dispose() { guards.delete(guard); subscription.dispose(); } };
  };
  router.addLeaveDecision = (decision) => {
    decisions.add(decision);
    const subscription = addDecision.call(router, decision);
    return { dispose() { decisions.delete(decision); subscription.dispose(); } };
  };
  // Includes password/model fields, CodeMirror, chat composition and attached files. Saving
  // does not clear this latch: some pages keep additional drafts or pending writes in memory.
  const retain = () => { edited = true; };
  const events = ['beforeinput', 'input', 'change', 'paste', 'cut', 'drop'] as const;
  for (const event of events) doc.addEventListener(event, retain, true);
  const click = (event: Event) => {
    const target = event.target;
    if (!target || (target as Element).nodeType !== 1) return;
    const element = target as Element;
    // Buttons can create drafts too (withdraw a chat message, choose a vendor, autosave a
    // preference). Their writes may still be pending; only the static preview is read-only.
    if (!element.closest('.home-petpreview')
      && element.closest('.home-vendor, .featureslot button, .featureslot [role="button"]')) retain();
  };
  doc.addEventListener('click', click, true);
  const bridge = {
    canReclaim: () => {
      try {
        if (!state.ready() || edited || decisions.size || !SAFE_ROUTES.has(state.route() ?? '')
          || doc.querySelector('iframe, [role="dialog"], dialog[open], [aria-busy="true"]')) return false;
        return ![...guards].some((guard) => !!guard());
      }
      catch { return false; }
    },
  };
  const global = win as Window & { __coopanionSettingsLifecycle?: typeof bridge };
  global.__coopanionSettingsLifecycle = bridge;
  const beforeUnload = (event: BeforeUnloadEvent) => {
    // User closes hide the window first. Keep the final check synchronous and fail closed;
    // the main process never bypasses this with BrowserWindow.destroy().
    if (doc.hidden && !bridge.canReclaim()) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  win.addEventListener('beforeunload', beforeUnload);
  return {
    dispose() {
      for (const event of events) doc.removeEventListener(event, retain, true);
      doc.removeEventListener('click', click, true);
      win.removeEventListener('beforeunload', beforeUnload);
      router.addLeaveGuard = addGuard;
      router.addLeaveDecision = addDecision;
      if (global.__coopanionSettingsLifecycle === bridge) delete global.__coopanionSettingsLifecycle;
    },
  };
}
