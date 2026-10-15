import type { ExtensionAPI, SlashCommandInfo } from '@earendil-works/pi-coding-agent';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';

const aliases = [
  { name: 'init', skill: 'skill:init', description: 'Create or update this project’s AGENTS.md' },
  { name: 'skill-creator', skill: 'skill:skill-creator', description: 'Create, evaluate, and improve a Pi skill' },
] as const;
const aliasPattern = /^\/(init|skill-creator)(?=\s|$)/;
const whitespacePattern = /\s/;

function isAvailable(alias: typeof aliases[number], commands: SlashCommandInfo[]): boolean {
  return commands.some(command => command.source === 'skill' && command.name === alias.skill)
    && !commands.some(command => command.name === alias.name);
}

export default function registerSkills(pi: ExtensionAPI): void {
  // Transform the original prompt so Pi owns expansion, streaming and completion.
  // Fire-and-forget sendUserMessage would let print mode dispose a running turn.
  pi.on('input', (event, ctx) => {
    const match = aliasPattern.exec(event.text);
    if (!match) return;
    const alias = match[1] === 'init' ? aliases[0] : aliases[1];
    const commands = pi.getCommands();
    if (commands.some(command => command.name === alias.name)) return;
    if (!commands.some(command => command.source === 'skill' && command.name === alias.skill)) {
      ctx.ui.notify(`Skill "${alias.name}" is not enabled. Check your Pi skill and package settings.`, 'warning');
      return { action: 'handled' };
    }
    const args = event.text.slice(match[0].length).trimStart();
    return { action: 'transform', text: `/${alias.skill}${args ? ` ${args}` : ''}` };
  });

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    const commands = pi.getCommands();
    const available = aliases.filter(alias => isAvailable(alias, commands));
    if (available.length === 0) return;
    const completions = new CombinedAutocompleteProvider(available, ctx.cwd);
    ctx.ui.addAutocompleteProvider(current => ({
      triggerCharacters: current.triggerCharacters,
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        const prefix = lines[cursorLine]?.slice(0, cursorCol) ?? '';
        if (options.force || !prefix.startsWith('/') || whitespacePattern.test(prefix)) return suggestions;
        const extra = await completions.getSuggestions(lines, cursorLine, cursorCol, options);
        if (!extra) return suggestions;
        return { prefix: extra.prefix, items: [...(suggestions?.items ?? []), ...extra.items] };
      },
      applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
        current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
      shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
    }));
  });
}
