import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const QUERY = 'datalab-kit:plan-mode-query';
type Session = ExtensionContext['sessionManager'];
interface PlanInvocation { command: string; cwd: string; toolName: string }
interface PlanQuery {
  session?: Session;
  enabled?: boolean;
  request?: PlanInvocation;
  checks?: Array<string | null | Promise<string | null>>;
}

/** Expose actual workflow ownership, rather than a potentially stale saved state. */
export function registerPlanModeReader(
  events: ExtensionAPI['events'],
  activeSession: () => Session | undefined,
  admit?: (session: Session, request: PlanInvocation) => string | null | Promise<string | null>,
): void {
  events.on(QUERY, data => {
    if (!data || typeof data !== 'object') return;
    const query = data as PlanQuery;
    if (query.session && query.session === activeSession()) query.enabled = true;
    if (query.session && query.request && query.checks) {
      if (admit) query.checks.push(admit(query.session, query.request));
      else if (query.enabled) query.checks.push('Plan mode command admission is unavailable');
    }
  });
}

/** Pi's event bus invokes synchronous listeners before emit returns. */
export function isPlanModeActive(events: ExtensionAPI['events'], session: Session | undefined): boolean {
  if (!session) return false;
  const query = { session, enabled: false };
  events.emit(QUERY, query);
  return query.enabled;
}

/** Forwarded calls must obey the serving parent's actual Plan tool-call handler. */
export async function vetoPlanInvocation(
  events: ExtensionAPI['events'], session: Session | undefined, request: PlanInvocation,
): Promise<string | null> {
  if (!session) return null;
  const checks: Array<string | null | Promise<string | null>> = [];
  const query: PlanQuery = { session, request, checks };
  events.emit(QUERY, query);
  for (const check of checks) {
    const reason = await check;
    if (reason !== null) return reason;
  }
  return null;
}
