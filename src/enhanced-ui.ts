import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Input, matchesKey, sliceByColumn, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { EnhancedApprovalRequest } from './enhanced-types.js';

/** Render terminal controls as evidence, never as terminal instructions. */
function terminalSafe(value: string, allowNewlines = true): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, character => {
    if (allowNewlines && character === '\n') return '\n';
    const code = character.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** A local, one-invocation approval. It never creates a permission grant. */
export async function requestEnhancedApproval(
  ctx: ExtensionContext,
  request: EnhancedApprovalRequest,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI || !ctx.ui || signal?.aborted) return false;
  if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') return false;
  const disclosure = [
    `Requester: ${terminalSafe(request.agentName ?? 'unnamed agent')} (${terminalSafe(request.toolName)})`,
    `Working directory: ${terminalSafe(request.cwd)}`,
    '',
    'Full invocation:',
    terminalSafe(request.command),
    '',
    'Reasons:',
    ...request.reasons.map(reason => `- ${terminalSafe(reason)}`),
    '',
    'Approval applies only to this unchanged invocation. No session permission is granted.',
    'Type exact lowercase yes and press Enter to approve. Esc or Ctrl-C cancels.',
  ].join('\n');
  let nativeAbort: (() => void) | undefined;
  try {
    if (ctx.mode === 'rpc') {
      let onAbort: (() => void) | undefined;
      try {
        const cancelled = new Promise<undefined>(resolve => {
          if (!signal) return;
          onAbort = () => resolve(undefined);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) resolve(undefined);
        });
        const response = await Promise.race([
          ctx.ui.input(`DANGEROUS COMMAND — EXPLICIT APPROVAL REQUIRED\n\n${disclosure}`, 'yes', { signal }),
          cancelled,
        ]);
        return !signal?.aborted && response === 'yes';
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      }
    }
    const approved = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
      // The real Input emits Pi's cursor marker and handles Unicode/IME editing.
      const input = new Input({ prompt: '', placeholder: 'yes' });
      let closed = false;
      const finish = (approved: boolean): void => {
        if (closed) return;
        closed = true;
        signal?.removeEventListener('abort', onAbort);
        done(approved);
      };
      const onAbort = (): void => { finish(false); };
      nativeAbort = onAbort;
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) finish(false);
      let invalid = false;
      input.onSubmit = value => {
        if (value === 'yes') finish(true);
        else {
          invalid = true;
          tui.requestRender();
        }
      };
      input.onEscape = () => finish(false);
      // Theme error colors can be user-defined; fixed ANSI red guarantees the
      // required danger surface even with a theme whose error color is not red.
      const red = (text: string): string => `\x1b[31m${text}\x1b[39m`;
      let offset = 0;
      let pageSize = 1;
      let maxOffset = 0;
      let cachedWidth = -1;
      let content: string[] = [];
      let pasting = false;
      const component = {
        get focused() { return input.focused; },
        set focused(value: boolean) { input.focused = value; },
        render(width: number) {
          try {
            const bordered = width >= 6;
            const innerWidth = Math.max(1, width - (bordered ? 4 : 0));
            if (cachedWidth !== innerWidth) {
              // Wrapping happens before styling: no untrusted escape can affect it.
              content = wrapTextWithAnsi(disclosure, innerWidth).flatMap(line => {
                const lineWidth = visibleWidth(line);
                if (lineWidth <= innerWidth) return [line];
                const parts: string[] = [];
                for (let column = 0; column < lineWidth; column += innerWidth) {
                  parts.push(sliceByColumn(line, column, innerWidth));
                }
                return parts;
              });
              cachedWidth = innerWidth;
            }
            const title = wrapTextWithAnsi(theme.bold(innerWidth < 24 ? 'DANGER' : 'DANGEROUS COMMAND — EXPLICIT APPROVAL REQUIRED'), innerWidth);
            const instructions = wrapTextWithAnsi(invalid ? 'Not approved: exact yes + Enter' : 'yes + Enter; Esc cancels', innerWidth);
            const review = wrapTextWithAnsi('Ctrl+PgUp/PgDn: review', innerWidth);
            // Leave room for Pi's footer/status rows. Disclosure is paged, never
            // clipped; the approval field always remains visible and focused.
            const overhead = title.length + instructions.length + review.length + 3 + (bordered ? 2 : 0);
            pageSize = Math.max(1, tui.terminal.rows - 6 - overhead);
            maxOffset = Math.floor(Math.max(0, content.length - 1) / pageSize) * pageSize;
            offset = Math.min(Math.floor(offset / pageSize) * pageSize, maxOffset);
            const frame = (line: string): string => {
              const padded = line + ' '.repeat(Math.max(0, innerWidth - visibleWidth(line)));
              return red(bordered ? `│ ${padded} │` : padded);
            };
            const body = content.slice(offset, offset + pageSize);
            while (body.length < pageSize) body.push('');
            return [
              ...(bordered ? [red(`╔${'═'.repeat(width - 2)}╗`)] : []),
              ...title.map(frame),
              frame(''),
              ...body.map(frame),
              frame(''),
              ...review.map(frame),
              ...instructions.map(frame),
              ...input.render(innerWidth).map(frame),
              ...(bordered ? [red(`╚${'═'.repeat(width - 2)}╝`)] : []),
            ];
          } catch {
            finish(false);
            return [];
          }
        },
        handleInput(data: string) {
          if (closed) return;
          try {
            if (!data.includes('\x1b[200~') && (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c'))) finish(false);
            // Fullscreen Pi reserves unmodified page keys for the transcript.
            else if (!pasting && (matchesKey(data, 'pageUp') || matchesKey(data, 'ctrl+pageUp'))) offset = Math.max(0, offset - pageSize);
            else if (!pasting && (matchesKey(data, 'pageDown') || matchesKey(data, 'ctrl+pageDown'))) offset = Math.min(maxOffset, offset + pageSize);
            else {
              // Input normally strips pasted newlines. Preserve raw exactness and
              // neutralize pasted control sequences instead of normalizing to yes.
              const start = data.indexOf('\x1b[200~');
              if (start >= 0) {
                pasting = true;
                data = data.slice(start + 6);
                input.handleInput('\x1b[200~');
              }
              if (pasting) {
                const end = data.indexOf('\x1b[201~');
                input.handleInput(terminalSafe(end < 0 ? data : data.slice(0, end), false));
                if (end >= 0) {
                  pasting = false;
                  input.handleInput('\x1b[201~');
                  const remaining = data.slice(end + 6);
                  if (remaining) this.handleInput(remaining);
                }
              } else input.handleInput(data);
            }
            tui.requestRender();
          } catch {
            finish(false);
          }
        },
        invalidate() { cachedWidth = -1; input.invalidate(); },
        dispose() { finish(false); },
      };
      return component;
    }, { overlay: false });
    return !signal?.aborted && approved === true;
  } catch {
    return false;
  } finally {
    if (nativeAbort) signal?.removeEventListener('abort', nativeAbort);
  }
}
