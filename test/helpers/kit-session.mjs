import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgentSession, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent';
import { agentSandbox } from './agent-sandbox.mjs';

export async function startKit(t, subagentSettings) {
  const { cwd, agentDir, trackSession } = await agentSandbox(t);
  const original = { packages: [resolve('.')], defaultProvider: 'user-provider', defaultModel: 'user-model' };
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(original));
  if (subagentSettings) await writeFile(join(agentDir, 'subagents.json'), JSON.stringify(subagentSettings));
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
  });
  trackSession(session);
  return { session, extensionsResult, agentDir, original };
}
