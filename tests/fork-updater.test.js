import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('Hachimist fork updates', () => {
  it('never loads or runs the upstream updater, including packaged Windows and AppImage builds', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const module = { exports: {} };
      const unexpected = () => { throw new Error('Fork must not contact or install upstream releases'); };
      vm.runInNewContext(readFileSync(new URL('../app/updater.cjs', import.meta.url), 'utf8'), {
        module, process: { platform, env: { APPIMAGE: '/tmp/Coopanion.AppImage' } },
        require: (name) => {
          if (name === 'electron') return { app: { isPackaged: true } };
          if (name === 'node:fs') return { createWriteStream: unexpected, mkdirSync: unexpected };
          if (name === 'node:path') return { join: () => '' };
          return unexpected();
        },
      });
      const updater = module.exports.startUpdater({ logDir: '/unused', tell: unexpected });
      expect(updater.installOnQuit()).toBe(false);
      expect(updater.installNow()).toBeUndefined();
    }
  });
});
