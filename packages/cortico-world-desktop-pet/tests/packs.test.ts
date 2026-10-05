import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptWords, figurePacks, readManifest, type FigurePack } from '../src/packs.ts';

function pack(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'));
  writeFileSync(join(dir, 'figure.json'), JSON.stringify(manifest));
  return dir;
}
const base = { manifest: 1, api: 1, id: 'robot', name: { zh: '机器人' }, about: { zh: '一个机器人' }, entry: 'figure.js', export: 'createFigure', axes: [], presets: [] };

describe('figure packs', () => {
  it('reads the built-in whale', () => {
    const { packs, problems } = figurePacks([]);
    expect(problems).toEqual([]);
    expect(packs.map((p) => p.id)).toEqual(['whale']);
  });

  it('refuses a pack whose files lie outside it', () => {
    expect(readManifest(pack({ ...base, entry: '../../web/pet-app.js' }))).toMatch(/entry/);
    expect(readManifest(pack({ ...base, model: 'C:/secrets.json' }))).toMatch(/model/);
  });

  it('a built-in id is not taken over by an installed pack', () => {
    const root = mkdtempSync(join(tmpdir(), 'packs-'));
    mkdirSync(join(root, 'fake'));
    writeFileSync(join(root, 'fake', 'figure.json'), JSON.stringify({ ...base, id: 'whale' }));
    const { packs, problems } = figurePacks([root]);
    expect(packs.filter((p) => p.id === 'whale').map((p) => p.builtin)).toEqual([true]);
    expect(problems).toHaveLength(1);
  });

  it('tells each word the body does not do as asked', () => {
    const dir = pack({ ...base, unsupported: { dance: 'hop', smug: null } });
    const m = readManifest(dir);
    if (typeof m === 'string') throw new Error(m);
    const p: FigurePack = { id: m.id, dir, base: '/packs/robot/', builtin: false, manifest: m };
    const { words, told } = adaptWords(['happy', 'dance', 'smug'], p);
    expect(words).toEqual(['happy', 'hop']);
    expect(told).toHaveLength(2);
  });
});
