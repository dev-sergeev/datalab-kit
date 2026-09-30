import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createAgentSession, SettingsManager, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { agentSandbox } from './agent-sandbox.mjs';

export async function start(t, config, answer = 'Отмена') {
  const { cwd, agentDir, trackSession } = await agentSandbox(t);
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
  trackSession(session);
  assert.deepEqual(extensionsResult.errors, []);
  const prompts = [];
  const ui = { ...session.extensionRunner.getUIContext(), select: async (...args) => { prompts.push(args); return answer; } };
  await session.bindExtensions({ uiContext: ui, mode: 'rpc' });
  return { runner: session.extensionRunner, prompts, cwd };
}
