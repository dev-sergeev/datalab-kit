import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startKit } from './helpers/kit-session.mjs';

test('all eight components load in Pi and preserve the selected provider and model', async t => {
  const { session, extensionsResult, agentDir, original } = await startKit(t);
  assert.deepEqual(extensionsResult.errors, []);
  assert.equal(extensionsResult.extensions.length, 8);
  const tools = session.getAllTools().map(tool => tool.name);
  assert.ok(tools.includes('subagent'));
  assert.ok(tools.includes('ask_user_question'));
  assert.ok(tools.some(name => name.includes('todo')));
  assert.ok(session.modelRuntime.getModels('gigachat').length > 0);
  const prompts = [];
  const ui = { ...session.extensionRunner.getUIContext(), select: async (_title, options) => { prompts.push(options); } };
  await session.bindExtensions({ uiContext: ui, mode: 'rpc' });
  const command = session.extensionRunner.getCommand('subagents:settings');
  assert.ok(command);
  await command.handler('', session.extensionRunner.createCommandContext());
  assert.ok(prompts.flat().includes('Max concurrency (current: 1)'));
  const subagent = session.getAllTools().find(tool => tool.name === 'subagent');
  assert.equal(subagent.parameters.properties.prompt.type, 'string');
  assert.equal(subagent.parameters.properties.tasks, undefined, 'one task per invocation');
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')), original);
});
