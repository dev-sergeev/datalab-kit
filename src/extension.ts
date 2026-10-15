import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { gigaChatExtensionPath, hasConfiguredGigaChat, managedAgentDir, registerGigaChat } from './install.js';
import registerDataLab from './datalab-provider.js';

export default async function datalabKit(pi: ExtensionAPI): Promise<void> {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const agentDir = getAgentDir();
  for (const [name, description] of [
    ['init', 'Create or update this project’s AGENTS.md'],
    ['skill-creator', 'Create, evaluate, and improve a Pi skill'],
  ] as const) {
    const skillCommand = `skill:${name}`;
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        if (!pi.getCommands().some(command => command.source === 'skill' && command.name === skillCommand)) {
          ctx.ui.notify(`Skill "${name}" is not enabled. Check your Pi skill and package settings.`, 'warning');
          return;
        }
        const commandArgs = args.trim();
        pi.sendUserMessage(`/${skillCommand}${commandArgs ? ` ${commandArgs}` : ''}`, {
          expandPromptTemplates: true, deliverAs: 'followUp',
        });
      },
    });
  }
  const configured = await hasConfiguredGigaChat(agentDir);
  await registerDataLab(pi, gigaChatExtensionPath(packageRoot));
  // On the first load, provide GigaChat immediately. Later Pi discovers the
  // standalone source itself, so the provider must not be registered twice.
  if (!configured) {
    const provider = await import(pathToFileURL(gigaChatExtensionPath(packageRoot)).href) as {
      default: (pi: ExtensionAPI) => void | Promise<void>;
    };
    await provider.default(pi);
  }
  if (!configured && managedAgentDir(packageRoot) === resolve(agentDir)) {
    pi.on('session_start', async () => {
      // Pi 0.85.1 persists a cached package list after npm postinstall; repair
      // that list at first activation without downloading or updating anything.
      await registerGigaChat(agentDir);
    });
  }
}
