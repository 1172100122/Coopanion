/** One readiness check for startup, the guide, and account-backed model connections. */
import { join } from 'node:path';
import type { CoreConfig } from 'cortico/core/types.ts';
import type { ProviderModule } from 'cortico/providers/base.ts';
import { secretReader } from 'cortico/core/secrets.ts';
import { endpointAvailability } from 'cortico/providers/configuration.ts';

export function connectionReady(config: CoreConfig, root: string, findModule: (kind: string) => ProviderModule): boolean {
  const entry = config.providers[config.activeProvider];
  if (!entry) return false;
  try {
    const module = findModule(entry.kind);
    const hasSecret = !entry.secret || secretReader(join(root, config.activeProvider, '.env'))(entry.secret) !== '';
    return endpointAvailability(module, config.activeProvider, entry, hasSecret, config.language ?? 'zh').ready;
  } catch { return false; }
}
