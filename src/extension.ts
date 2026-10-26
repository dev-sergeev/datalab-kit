import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { hasConfiguredGigaChat, managedAgentDir, registerGigaChat } from './install.js';
import registerDataLab from './datalab-provider.js';
import registerSkills from './skills.js';
import registerGigaChatExtension from './gigachat-stream.js';

export default async function datalabKit(pi: ExtensionAPI): Promise<void> {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const agentDir = getAgentDir();
  registerSkills(pi);
  const configured = await hasConfiguredGigaChat(agentDir);
  await registerDataLab(pi);
  // On the first load, provide GigaChat immediately. Later Pi discovers the
  // standalone source itself, so the provider must not be registered twice.
  if (!configured) await registerGigaChatExtension(pi);
  if (managedAgentDir(packageRoot) === resolve(agentDir)) {
    pi.on('session_start', async () => {
      // Pi 0.85.1 persists a cached package list after npm postinstall; repair
      // that list and migrate former kit sources without networking.
      await registerGigaChat(agentDir);
    });
  }
}
