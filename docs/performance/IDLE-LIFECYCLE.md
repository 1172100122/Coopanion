# Desktop idle lifecycle

## Behavior

- Closing settings hides immediately. After 30 seconds, an untouched supported console page may close its BrowserWindow to release its renderer. Reopening restores its last route, normal bounds and maximized state. A quick reopen cancels the pending release.
- Reclaim is conservative. Input, file drops, action buttons, dirty leave guards, pending decisions, dialogs, busy content, embedded frames and unsupported routes retain the page. Saving does not reset the edited-session latch. Dress and unfamiliar provider editors remain loaded, protecting their drafts.
- The Home preview is a static avatar button opening Dress. Dress keeps its interactive preview. Hidden Home pages stop status polling.
- The pet host explicitly reports native hide/show/minimize/restore and system suspend/resume. Only visual work and pointer sampling pause; the World, websocket, reminders, microphone preference and core processing remain independent.
- Tray and second-instance reveal reuse the native window and websocket; they no longer close/restart the pet process. Browser tabs cannot consume a native reveal request.
- Resume starts one fresh frame chain with no hidden-time catch-up. Pending speech/questions remain queued. Pointer/gaze baselines reset; lost capture and stale cross-display callbacks cannot synthesize a poke, pat or throw.
- Kit figures apply the same two halo shadows to an untransformed SVG group containing the body and effects, rather than the full-screen transparent iframe. Radii remain 3 and 7 stage pixels. Older figure bodies without the optional `setHalo(k)` capability retain their original iframe filter.

## Verification

Run the application's normal checks:

```
pnpm test
pnpm test:worlds
pnpm build:cortico
pnpm typecheck
pnpm typecheck:web
pnpm typecheck:worlds
```

Focused tests cover settings clean/dirty decisions and close/reopen races, frame-loop cancellation and timing, native visibility/cursor timers, hidden dialog/order handling, pointer cancellation and halo capability fallback. Existing Hachimist four-second gaze/action tests remain part of the suite.

For native validation, use an isolated profile with no model credentials and disable voice, CUA and telemetry. Exercise quick reopen, clean close longer than 30 seconds, draft retention, Dress retention, repeated visibility toggles, sleep/resume and an outgoing reminder received while hidden. Check real pointer dragging and gaze, and compare the halo on light/dark backgrounds. Native suspend-event injection tests the app handler, not actual operating-system sleep or cross-monitor Windows behavior.

For performance comparisons, measure the entire process tree. CPU 100% means one logical core; use summed proportional set size (PSS), not summed RSS. Warm the TypeScript runtime cache equally for both variants, warm the app, then take multiple timed windows without running builds, tests, capture loops or renderer probes concurrently. Keep the profile configuration, display, GPU backend and scenario order fixed. Wait longer than the 30-second settings grace period before the closed-window sample. Report cold-start/helper-process differences separately.

Linux software-compositing measurements do not predict Windows/macOS hardware-accelerated CPU, GPU or battery consumption. Destroying a renderer does not immediately release every Electron/compositor cache. Edited settings pages intentionally keep their memory until a safe later lifetime boundary.
