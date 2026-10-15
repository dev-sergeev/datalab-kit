import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgentSession, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent';
import { agentSandbox } from './agent-sandbox.mjs';

export function isolateGigaChatEnv(t, changes = {}) {
  const names = new Set([
    ...Object.keys(process.env).filter(name => name.startsWith('GIGACHAT_')),
    'JPY_API_TOKEN',
    ...Object.keys(changes),
  ]);
  const previous = Object.fromEntries([...names].map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  for (const [name, value] of Object.entries(changes)) {
    if (value !== undefined) process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

export async function startKit(t, subagentSettings, { model } = {}) {
  const { cwd, agentDir, trackSession } = await agentSandbox(t);
  const original = { packages: [resolve('.')], defaultProvider: 'user-provider', defaultModel: 'user-model' };
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(original));
  if (subagentSettings) await writeFile(join(agentDir, 'subagents.json'), JSON.stringify(subagentSettings));
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd), model,
  });
  trackSession(session);
  return { session, extensionsResult, agentDir, original };
}
