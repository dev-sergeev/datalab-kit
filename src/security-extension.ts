import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { ENHANCED_ADAPTER_VERSION, ENHANCED_READINESS_KEY, PERMISSION_SYSTEM_VERSION } from './enhanced-types.js';
import type { EnhancedReadiness } from './enhanced-types.js';

/** Register independently of host-backed imports: Jiti supplies SDK aliases in installed kits. */
export default function securityExtension(pi: ExtensionAPI): void {
  const require = createRequire(import.meta.url);
  pi.on('tool_call', (_event, ctx) => {
    try {
      const service = require.resolve('@gotgenes/pi-permission-system');
      const metadata: unknown = JSON.parse(readFileSync(resolve(dirname(service), '../package.json'), 'utf8'));
      if (!metadata || typeof metadata !== 'object' || !('version' in metadata)
        || metadata.version !== PERMISSION_SYSTEM_VERSION) {
        return { block: true, reason: 'Datalab Kit: incompatible permission-system; restore the supported kit before executing tools.' };
      }
      const readiness = (globalThis as Record<symbol, unknown>)[Symbol.for(ENHANCED_READINESS_KEY)] as Partial<EnhancedReadiness> | undefined;
      if (!readiness || readiness.version !== ENHANCED_ADAPTER_VERSION
        || readiness.upstreamVersion !== PERMISSION_SYSTEM_VERSION
        || typeof readiness.isReady !== 'function' || readiness.isReady(ctx) !== true) {
        return { block: true, reason: 'Datalab Kit: enhanced approval adapter is unavailable; tool execution is blocked.' };
      }
    } catch {
      return { block: true, reason: 'Datalab Kit: security integration failed; tool execution is blocked.' };
    }
    return undefined;
  });
}
