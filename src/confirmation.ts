import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, wrapTextWithAnsi } from '@earendil-works/pi-tui';

type DialogTheme = { fg(color: 'warning' | 'accent' | 'muted', text: string): string; bold(text: string): string };

/** One instance represents one decision; it never remembers a session grant. */
export class ConfirmationDialog {
  private approve = false;
  private finished = false;
  private scroll = 0;

  constructor(
    private readonly command: string,
    private readonly theme: DialogTheme,
    private readonly done: (approved: boolean) => void,
  ) {}

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, 'down')) this.approve = true;
    else if (matchesKey(data, 'up')) this.approve = false;
    else if (matchesKey(data, 'pageDown')) this.scroll += 10;
    else if (matchesKey(data, 'pageUp')) this.scroll = Math.max(0, this.scroll - 10);
    else if (matchesKey(data, 'escape') || matchesKey(data, 'enter')) {
      this.finished = true;
      this.done(matchesKey(data, 'enter') && this.approve);
    }
  }

  render(width: number): string[] {
    const usableWidth = Math.max(1, width - 4);
    const safeText = this.command.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
    const lines = safeText.split('\n').flatMap(line => wrapTextWithAnsi(line, usableWidth));
    this.scroll = Math.min(this.scroll, Math.max(0, lines.length - 12));
    const choices = ['Отмена', 'Разрешить один раз'];
    return [
      this.theme.fg('warning', this.theme.bold('ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ')),
      ...lines.slice(this.scroll, this.scroll + 12).map(line => this.theme.fg('warning', line)),
      ...(lines.length > 12 ? [this.theme.fg('muted', `Строки ${this.scroll + 1}–${Math.min(this.scroll + 12, lines.length)} из ${lines.length}; PgUp/PgDn — просмотр`)] : []),
      '',
      ...choices.map((label, index) => this.theme.fg(index === Number(this.approve) ? 'accent' : 'muted', `${index === Number(this.approve) ? '▶' : ' '} ${label}`)),
      this.theme.fg('muted', '↓ затем Enter — разрешить один раз; Enter по умолчанию / Esc — отменить'),
    ].flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
  }

  invalidate(): void {}
}

type PermissionPayload = {
  request: { value: string; toolName: string | null; surface: string; executedUnit: string | null };
  evidence: readonly { label: string; text: string; detail: string | null }[];
};

export async function confirmPermission(
  ui: Pick<ExtensionUIContext, 'custom' | 'select'>,
  mode: string,
  title: string,
  payload: PermissionPayload,
): Promise<boolean> {
  const details = [title, `${payload.request.toolName ?? payload.request.surface}: ${payload.request.value}`,
    ...(payload.request.executedUnit ? [`Выполняется: ${payload.request.executedUnit}`] : []),
    ...payload.evidence.map(item => `${item.label}: ${item.text}${item.detail ? `\n${item.detail}` : ''}`),
  ].join('\n');
  if (mode !== 'tui') {
    return (await ui.select(details, ['Отмена', 'Разрешить один раз'])) === 'Разрешить один раз';
  }
  return ui.custom<boolean>((tui, theme, _keys, done) => {
    const dialog = new ConfirmationDialog(details, theme, done);
    return {
      render: width => dialog.render(width),
      invalidate: () => dialog.invalidate(),
      handleInput: data => { dialog.handleInput(data); tui.requestRender(); },
    };
  });
}
