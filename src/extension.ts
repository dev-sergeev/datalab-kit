import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Api, Provider } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { gigaChatExtensionPath, hasConfiguredGigaChat, managedAgentDir, registerGigaChat } from './install.js';
import { configureRecapDefault } from './recap.js';

export default async function datalabKit(pi: ExtensionAPI): Promise<void> {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const agentDir = getAgentDir();
  await configureRecapDefault(agentDir);
  const configured = await hasConfiguredGigaChat(agentDir);
  // On the first load, provide GigaChat immediately. Later Pi discovers the
  // standalone source itself, so the provider must not be registered twice.
  if (!configured) {
    const provider = await import(pathToFileURL(gigaChatExtensionPath(packageRoot)).href) as {
      gigachatProvider?: Provider<Api>;
      default: (pi: ExtensionAPI) => void;
    };
    // The standalone package also sets the main model on first activation.
    // The kit supplies only its provider, preserving the user's session choice.
    if (provider.gigachatProvider) pi.registerProvider(provider.gigachatProvider);
    else await provider.default(pi);
  }
  if (!configured && managedAgentDir(packageRoot) === resolve(agentDir)) {
    pi.on('session_start', async () => {
      // Pi 0.85.1 persists a cached package list after npm postinstall; repair
      // that list at first activation without downloading or updating anything.
      await registerGigaChat(agentDir);
    });
  }
}
