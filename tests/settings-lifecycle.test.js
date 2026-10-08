import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { installSettingsLifecycle } from '../console/settings-lifecycle.ts';
import { createPetPreview } from '../console/features/home/preview.ts';

const cleanups = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); });

function fixture(route = 'home') {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:12345/#/home' });
  const doc = dom.window.document;
  const state = {
    route: () => route,
    ready: () => true,
    router: {
      addLeaveGuard: () => ({ dispose() {} }),
      addLeaveDecision: () => ({ dispose() {} }),
    },
  };
  const lifecycle = installSettingsLifecycle(doc, state);
  cleanups.push(() => { lifecycle.dispose(); dom.window.close(); });
  return { win: dom.window, doc, state, lifecycle, canReclaim: () => dom.window.__coopanionSettingsLifecycle.canReclaim() };
}

describe('settings cleanliness contract', () => {
  it('allows untouched, fully loaded supported pages only', () => {
    const { state, canReclaim } = fixture();
    expect(canReclaim()).toBe(true);
    state.ready = () => false;
    expect(canReclaim()).toBe(false);
    for (const route of ['dress', 'providers', 'provider', 'extensions', 'unknown']) {
      expect(fixture(route).canReclaim()).toBe(false);
    }
  });

  it.each(['beforeinput', 'input', 'change', 'paste', 'cut', 'drop'])('retains edits for the session after %s, including route changes', (event) => {
    const { win, doc, state, canReclaim } = fixture();
    const input = doc.createElement('input');
    input.type = 'password';
    doc.body.append(input);
    input.value = 'unsaved fixture';
    input.dispatchEvent(new win.Event(event, { bubbles: true }));
    input.value = '';
    state.route = () => 'usage';
    expect(canReclaim()).toBe(false);
  });

  it('retains home vendor changes even before typing and permits ordinary navigation clicks', () => {
    const { doc, canReclaim } = fixture();
    const button = doc.createElement('button');
    const label = doc.createElement('span');
    button.append(label);
    doc.body.append(button);
    label.click();
    expect(canReclaim()).toBe(true);
    button.className = 'home-vendor';
    label.click();
    expect(canReclaim()).toBe(false);
  });

  it('consults leave guards, retains unknown async decisions and fails closed on guard errors', () => {
    const { state, canReclaim } = fixture('prompts');
    let dirty = false;
    const guard = state.router.addLeaveGuard(() => dirty ? 'unsaved' : null);
    expect(canReclaim()).toBe(true);
    dirty = true;
    expect(canReclaim()).toBe(false);
    guard.dispose();
    expect(canReclaim()).toBe(true);
    const broken = state.router.addLeaveGuard(() => { throw new Error('unknown'); });
    expect(canReclaim()).toBe(false);
    broken.dispose();
    const decision = state.router.addLeaveDecision(async () => true);
    expect(canReclaim()).toBe(false);
    decision.dispose();
    expect(canReclaim()).toBe(true);
  });

  it('retains button-created drafts and pending autosaves, but allows the static preview', () => {
    const { doc, canReclaim } = fixture('chat');
    doc.body.innerHTML = '<div class="featureslot"><button class="home-petpreview">Preview</button><button class="withdraw">Take back</button></div>';
    doc.querySelector('.home-petpreview').click();
    expect(canReclaim()).toBe(true);
    doc.querySelector('.withdraw').click();
    expect(canReclaim()).toBe(false);
  });

  it.each(['<iframe></iframe>', '<div role="dialog"></div>', '<dialog open></dialog>', '<div aria-busy="true"></div>'])('keeps embedded editors, open dialogs and busy operations (%s)', (html) => {
    const { doc, canReclaim } = fixture();
    doc.body.innerHTML = html;
    expect(canReclaim()).toBe(false);
    doc.body.replaceChildren();
    expect(canReclaim()).toBe(true);
  });

  it('rechecks edits in beforeunload and disposes its listeners and bridge', () => {
    const { win, doc, lifecycle } = fixture();
    const before = new win.Event('beforeunload', { cancelable: true });
    win.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    doc.body.dispatchEvent(new win.Event('input', { bubbles: true }));
    const after = new win.Event('beforeunload', { cancelable: true });
    win.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(true);
    lifecycle.dispose();
    expect(win.__coopanionSettingsLifecycle).toBeUndefined();
    const disposed = new win.Event('beforeunload', { cancelable: true });
    win.dispatchEvent(disposed);
    expect(disposed.defaultPrevented).toBe(false);
  });
});

describe('home pet preview', () => {
  it('uses only a static image and opens the live dressing page on demand', () => {
    const { win, doc } = fixture();
    const controller = new win.AbortController();
    let opened = 0;
    const preview = createPetPreview(doc, 'Open dressing preview', () => { opened++; }, controller.signal);
    doc.body.append(preview);
    expect(preview.querySelector('iframe, canvas, video')).toBe(null);
    expect(preview.querySelector('img').getAttribute('src')).toBe('/api/avatar');
    expect(preview.textContent).toBe('Open dressing preview');
    preview.click();
    expect(opened).toBe(1);
    controller.abort();
    preview.click();
    expect(opened).toBe(1);
  });

  it('keeps the dressing affordance when no avatar is available', () => {
    const { win, doc } = fixture();
    const preview = createPetPreview(doc, 'Open dressing preview', () => {}, new win.AbortController().signal);
    const image = preview.querySelector('img');
    image.dispatchEvent(new win.Event('error'));
    expect(image.hidden).toBe(true);
    expect(preview.textContent).toBe('Open dressing preview');
  });
});
