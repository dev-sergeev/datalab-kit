import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { gigaChatExtensionPath, hasConfiguredGigaChat, managedAgentDir, registerGigaChat } from './install.js';

export default async function datalabKit(pi: ExtensionAPI): Promise<void> {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const agentDir = getAgentDir();
  // On the first load, provide GigaChat immediately. Later Pi discovers the
  // standalone source itself, so the provider must not be registered twice.
  if (!await hasConfiguredGigaChat(agentDir)) {
    const provider = await import(pathToFileURL(gigaChatExtensionPath(packageRoot)).href) as { default: (pi: ExtensionAPI) => void };
    provider.default(pi);
  }
  if (managedAgentDir(packageRoot) === resolve(agentDir)) {
    pi.on('session_start', async () => {
      // Pi 0.85.1 persists a cached package list after npm postinstall; repair
      // that list at first activation without downloading or updating anything.
      await registerGigaChat(agentDir);
    });
  }
}
