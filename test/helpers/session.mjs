import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createAgentSession, SettingsManager, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { agentSandbox } from './agent-sandbox.mjs';

export async function start(t, config, answer = 'No', { planMode = false, todo = false, planSettings, sessionManager } = {}) {
  const { cwd, agentDir, trackSession } = await agentSandbox(t);
  if (config !== undefined) {
    const folder = join(agentDir, 'extensions', 'pi-permission-system');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  if (planSettings) await writeFile(join(agentDir, 'pi-plan-mode.json'), JSON.stringify(planSettings));
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    additionalExtensionPaths: [
      ...(planMode ? [resolve('node_modules/@narumitw/pi-plan-mode/dist/index.ts')] : []),
      resolve('node_modules/@gotgenes/pi-permission-system/src/index.ts'),
      ...(todo ? [resolve('node_modules/@capdiem/pi-todo/index.min.js')] : []),
    ],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, settingsManager: settings,
    resourceLoader: loader, sessionManager: sessionManager ?? SessionManager.inMemory(cwd),
  });
  trackSession(session);
  assert.deepEqual(extensionsResult.errors, []);
  const prompts = [];
  const statuses = new Map();
  const notices = [];
  const ui = { ...session.extensionRunner.getUIContext(),
    select: async (...args) => { prompts.push(args); return typeof answer === 'function' ? answer(...args) : answer; },
    setStatus: (key, value) => { statuses.set(key, value); },
    notify: (...args) => { notices.push(args); },
  };
  await session.bindExtensions({ uiContext: ui, mode: 'rpc' });
  return { runner: session.extensionRunner, session, prompts, statuses, notices, cwd, agentDir };
}
