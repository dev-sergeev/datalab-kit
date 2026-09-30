import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const QUERY = 'datalab-kit:plan-mode-query';
type Session = ExtensionContext['sessionManager'];

/** Expose actual workflow ownership, rather than a potentially stale saved state. */
export function registerPlanModeReader(events: ExtensionAPI['events'], activeSession: () => Session | undefined): void {
  events.on(QUERY, data => {
    if (!data || typeof data !== 'object') return;
    const query = data as { session?: Session; enabled?: boolean };
    if (query.session && query.session === activeSession()) query.enabled = true;
  });
}

/** Pi's event bus invokes synchronous listeners before emit returns. */
export function isPlanModeActive(events: ExtensionAPI['events'], session: Session | undefined): boolean {
  if (!session) return false;
  const query = { session, enabled: false };
  events.emit(QUERY, query);
  return query.enabled;
}
