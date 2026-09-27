import type { WorldDefinition } from 'cortico/world.ts';
import { CUA_DEFAULTS, CUA_ID, type CuaConfigSection } from './config.ts';
import { CuaWorld, type CuaWorldOptions } from './world.ts';

/** The definition, with how an embedding app asks the person for permission (see `CuaWorldOptions`). */
export function cuaDefinition(assembly: Pick<CuaWorldOptions, 'askPermission'> = {}): WorldDefinition<CuaConfigSection> {
  return {
    id: CUA_ID,
    label: '电脑操作',
    defaults: () => structuredClone(CUA_DEFAULTS),
    preflight: () => {
      if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('电脑操作 World 只支持 Windows 和 macOS。');
    },
    // ctx.cfg is the live `worlds.cua` section: every key is read at use
    create: (ctx) => new CuaWorld({ cfg: ctx.cfg, timezone: ctx.timezone, botName: ctx.botName, askPermission: assembly.askPermission }),
  };
}

export const CUA = cuaDefinition();
