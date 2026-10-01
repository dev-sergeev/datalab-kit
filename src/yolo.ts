import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

/** Session overrides stay in memory; persistent settings retain their own value. */
export function registerYoloControl(pi: ExtensionAPI, configured: () => boolean): { isEnabled(): boolean; refresh(ctx?: ExtensionContext): void } {
  let override: boolean | undefined;
  let context: ExtensionContext | undefined;
  const enabled = () => override ?? configured();
  const refresh = (ctx?: ExtensionContext) => {
    if (ctx) context = ctx;
    context?.ui.setStatus('pi-permission-system', enabled() ? 'yolo' : undefined);
  };
  pi.on('session_start', (_event, ctx) => {
    override = undefined;
    context = ctx;
  });
  pi.registerCommand('yolo', {
    description: 'Set session YOLO: on, off, or status; explicit deny and Plan mode remain active',
    getArgumentCompletions: prefix => ['on', 'off', 'status'].filter(value => value.startsWith(prefix))
      .map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      context = ctx;
      const command = args.trim().toLowerCase() || 'status';
      if (!['on', 'off', 'status'].includes(command)) {
        ctx.ui.notify('Usage: /yolo on|off|status', 'warning');
        return;
      }
      if (command !== 'status') override = command === 'on';
      refresh();
      ctx.ui.notify(`YOLO ${enabled() ? 'on' : 'off'} (${override === undefined ? 'settings' : 'session'}). Explicit deny and Plan mode remain active.`, 'info');
    },
  });
  return { isEnabled: () => { refresh(); return enabled(); }, refresh };
}
