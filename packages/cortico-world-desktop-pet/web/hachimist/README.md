<!-- Owner: figure.js; figure.json; ../../examples/hachimist/ -->

# Hachimist

The default companion in this fork uses the approved Hachimist artwork: loose golden hair, blue eyes, golden wolf ears and tail, a plum botanical dress and black lace-up boots. Coo and the whale remain available in Dress, and Coo remains the fallback if a pack cannot load.

## Artwork

`spritesheet.png` is an unchanged copy of the final AI-generated Hachimist v2 atlas. Its SHA-256 is `b5f9ac315bcb201a23e38e8235f30af0f1a9c7b7504ebacd07822a9b62c49536`. It contains 73 frames in an 8 × 11 grid: 192 × 208 pixels per cell, 1536 × 2288 overall. `thumb.png` and the new-install avatar use the approved first idle frame. Original upstream artwork, credits and licenses remain in their existing files. This fork does not submit these assets to the upstream project.

The renderer crops the original atlas in SVG. It does not repaint the character, add accessories or require WebGL. The existing kit supplies walking, turning, gravity, dragging, throwing, click handling, particles and host events inside the existing sandbox.

## Animation mapping and limits

- Idle → original idle loop; pointer tracking / look → all 16 directional frames, clockwise from up
- Natural blinking uses the kit's blink clock even while the pointer keeps a directional gaze active
- Walk / run → right- or left-running loop; the left row cancels the kit's horizontal flip because its source already faces left
- Wave stops walking/running before its full-body animation starts. If requested during carrying or a jump, one pending wave waits until the body settles. Repeated pending waves coalesce; a newer command, listening/thinking cue, direct touch or figure replacement cancels stale gestures. Other figures retain their existing layered gestures.
- Jump / hop → original takeoff, airborne and landing frames
- Sad, drag, dizzy → failed; listening → waiting; thinking → running/task loop; happy → gentle review/head-tilt loop
- Sit and sleep → dedicated six-frame strips; sleep retains the kit's sleep particles
- Talking while standing → dedicated six-frame mouth-motion strip driven by the host's text/talk pulses; it stops when pulses decay. This is character animation, not audio/phoneme lip-sync, and adds no TTS or microphone access. Physical movement, rest and explicit gestures retain priority.
- Unsupported expressions keep their existing fallback. Separate angry, crying and kiss art is not advertised.

The original atlas remains unchanged. `actions/sit.png`, `actions/sleep.png` and `actions/talk.png` are independent Coopanion-only transparent 1152 × 208 strips (six 192 × 208 cells each), with a common bottom anchor matching the original atlas. `actions/actions.json` records geometry and timing; `actions/artwork-provenance.json` records SHA-256 hashes and validation. These strips do not change the dot v2 pet schema or any saved pet/avatar.

Frame timing is defined in `STATES` and `ACTIONS` in `figure.js` (sit 5 fps, sleep 3 fps, talk 8 fps). The kit simulation still runs at the host frame rate. Four expressions and ten motions are advertised in `figure.json`. The [preview](../../examples/hachimist/) exposes sit, sleep and talk controls without an API key.

## Defaults and existing installations

Fresh deployments receive the Hachimist name, avatar and appearance description. Existing saved configuration, avatar and user-authored constitution are preserved by the original seed rules. Existing users can select **Dress → Hachimist**; changing the appearance does not change their saved name or personality. The original legacy seed upgrade remains unchanged.

## Updates

Automatic upstream updates and upstream release-download suggestions are disabled in this fork, and packaging emits no upstream update feed. Upstream installers do not contain the Hachimist customization. Updates must be reviewed and merged into this fork, then built from source; the original upstream source link remains available. No release or installer is created by the character change.

## Local smoke test

From the repository root:

```sh
node packages/cortico-world-desktop-pet/examples/hachimist/serve.mjs
```

Open `http://127.0.0.1:4319`. This loads the actual `body-host.js` / `figure-frame.js` sandbox without starting an agent, connecting a model provider, or requesting microphone/desktop access. Check Idle, Wave, Jump, Walk left, Run right, Thinking, Listening, Review, Sad, sleep fallback, both themes, repeated reload, and drag/release. The status line reports readiness and physical mode.

Automated coverage is in `tests/hachimist.test.js`: exact atlas checksum, grid/state counts, 16 directions, mappings, crop/frame reuse, left-facing correction, dimension failure, defaults/fallback, all advertised actions, walking interruption and repeated disposal.
