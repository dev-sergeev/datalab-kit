import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createAgentSession, SettingsManager, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

export async function start(t, config, answer = 'Отмена') {
  const root = await mkdtemp(join(tmpdir(), 'datalab-permissions-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  if (config !== undefined) {
    const folder = join(agentDir, 'extensions', 'pi-permission-system');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    additionalExtensionPaths: [resolve('node_modules/@gotgenes/pi-permission-system/src/index.ts')],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, settingsManager: settings,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
  });
  assert.deepEqual(extensionsResult.errors, []);
  const prompts = [];
  const ui = { ...session.extensionRunner.getUIContext(), select: async (...args) => { prompts.push(args); return answer; } };
  await session.bindExtensions({ uiContext: ui, mode: 'rpc' });
  t.after(async () => {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    session.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { runner: session.extensionRunner, prompts, cwd };
}
