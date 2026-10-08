import { loadBody } from '/web/body-host.js';
const stage = document.querySelector('#stage'), layer = document.querySelector('#layer'), status = document.querySelector('#status');
const manifest = await (await fetch('/web/hachimist/figure.json')).json();
const bounds = () => ({ W: stage.clientWidth, H: stage.clientHeight, floorY: stage.clientHeight - 28, S: 1.15 });
let body, theme = 'dark', previous = performance.now(), destroyed = false, mounting = null;
async function mount() {
  if (mounting) return mounting;
  mounting = (async () => {
    destroyed = true;
    body?.dispose();
    status.textContent = 'Loading the sandboxed figure…';
    body = await loadBody({ layer, pack: { ...manifest, base: '/web/hachimist/' }, start: { x: stage.clientWidth / 2, facing: 1, scheme: 'original', skin: { figure: 'hachimist', scheme: 'original' } }, theme, bounds: bounds(), onError: (error) => { status.textContent = `ERROR: ${error.message}`; destroyed = true; } });
    body.set({ roam: 'off' }); destroyed = false;
  })();
  try { await mounting; }
  catch (error) { status.textContent = `ERROR: ${error.message}`; }
  finally { mounting = null; }
}
await mount();
const controls = [
  ['Idle', () => { body.set({ listening: false, thinking: false }); body.do('neutral'); body.do('stand'); }],
  ['Wave', () => body.do('wave')], ['Jump', () => body.do('jump')],
  ['Walk left', () => body.walk(130, false, 1)], ['Run right', () => body.walk(stage.clientWidth - 130, true, 2)],
  ['Thinking', () => body.set({ listening: false, thinking: true })], ['Listening', () => body.set({ thinking: false, listening: true })],
  ['Review', () => { body.set({ listening: false, thinking: false }); body.do('happy'); }], ['Sad', () => { body.set({ listening: false, thinking: false }); body.do('sad'); }],
  ['Sit', () => { body.set({ listening: false, thinking: false }); body.do('sit'); }],
  ['Talk', () => { body.set({ listening: false, thinking: false }); body.do('stand'); const target = body; let n = 0; const id = setInterval(() => { if (destroyed || target !== body || ++n > 24) clearInterval(id); else target.talk(); }, 90); }],
  ['Sleep', () => { body.set({ listening: false, thinking: false }); body.do('sleep'); }],
  ['Light / dark', () => { theme = theme === 'dark' ? 'light' : 'dark'; document.body.classList.toggle('light', theme === 'light'); body.set({ theme }); }],
  ['Reload figure', () => mount()],
];
for (const [label, action] of controls) { const button = document.createElement('button'); button.textContent = label; button.onclick = action; document.querySelector('#actions').appendChild(button); }
function tick(now) { if (!destroyed) { body.tick(Math.min(.05, (now - previous) / 1000)); if (body.layout) status.textContent = `Figure: ${body.pack} · Mode: ${body.layout.mode} · Facing: ${body.layout.facing < 0 ? 'left' : 'right'} · Sandbox ready`; } previous = now; requestAnimationFrame(tick); }
requestAnimationFrame(tick);
const point = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() }; };
for (const [event, type] of [['pointerdown','down'],['pointermove','move'],['pointerup','up'],['pointercancel','cancel'],['pointerleave','leave']]) stage.addEventListener(event, (e) => { if (type === 'down') stage.setPointerCapture(e.pointerId); body.pointer(type, point(e)); });
addEventListener('resize', () => body.set({ bounds: bounds() }));
