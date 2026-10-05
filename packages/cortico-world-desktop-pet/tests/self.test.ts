import { describe, expect, it } from 'vitest';
import { DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { figurePacks } from '../src/packs.ts';
import { planSettings, type CooLooks } from '../src/self.ts';

const coo: CooLooks = { palettes: [['mint', '薄荷绿'], ['fox', '红狐狸']], accessories: { head: [['none', '无'], ['cat', '猫耳']] } };
const cfg = () => structuredClone(DESKTOP_PET_DEFAULTS);
const packs = figurePacks([]).packs;

describe('pet_set', () => {
  it('changes what reaches the person only after asking them', () => {
    const { changes } = planSettings({ roam: 'free', sound: false, scale: 1.5, theme: 'light', user: '小明', hoverButtons: ['chat'] }, cfg(), packs, coo);
    expect(Object.fromEntries(changes.map((c) => [c.key, c.tier]))).toEqual({ roam: 'self', sound: 'ask', scale: 'ask', theme: 'ask', user: 'ask', hoverButtons: 'ask' });
  });

  it('refuses settings that are not the bot\'s', () => {
    const { changes, errors } = planSettings({ asr: { enabled: false }, rememberPosition: true }, cfg(), packs, coo);
    expect(changes).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it('takes a pack\'s picks only for that pack', () => {
    expect(planSettings({ figure: 'whale', scheme: 'claude' }, cfg(), packs, coo).errors).toEqual([]);
    expect(planSettings({ scheme: 'claude' }, cfg(), packs, coo).errors).toHaveLength(1);
  });
});
