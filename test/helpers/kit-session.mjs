import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent';

export async function startKit(t, subagentSettings) {
  const root = await mkdtemp(join(tmpdir(), 'datalab-load-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  const original = { packages: [resolve('.')], defaultProvider: 'user-provider', defaultModel: 'user-model' };
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(original));
  if (subagentSettings) await writeFile(join(agentDir, 'subagents.json'), JSON.stringify(subagentSettings));
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    session.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { session, extensionsResult, agentDir, original };
}
