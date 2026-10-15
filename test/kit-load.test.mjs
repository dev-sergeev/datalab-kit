import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolateGigaChatEnv, startKit } from './helpers/kit-session.mjs';

test('kit tools and the stock GigaChat wizard load in Pi', async t => {
  isolateGigaChatEnv(t);
  const { session, extensionsResult, agentDir, original } = await startKit(t);
  assert.deepEqual(extensionsResult.errors, []);
  const tools = session.getAllTools().map(tool => tool.name);
  assert.ok(tools.includes('subagent'));
  assert.ok(tools.includes('ask_user_question'));
  assert.ok(tools.some(name => name.includes('todo')));
  const prompts = [];
  const ui = { ...session.extensionRunner.getUIContext(), select: async (_title, options) => {
    prompts.push(options);
  } };
  await session.bindExtensions({ uiContext: ui, mode: 'tui' });
  const gigachat = session.extensionRunner.getCommand('gigachat');
  assert.ok(gigachat);
  const command = session.extensionRunner.getCommand('subagents:settings');
  assert.ok(command);
  await command.handler('', session.extensionRunner.createCommandContext());
  assert.ok(prompts.flat().includes('Max concurrency (current: 1)'));
  const subagent = session.getAllTools().find(tool => tool.name === 'subagent');
  assert.equal(subagent.parameters.properties.prompt.type, 'string');
  assert.equal(subagent.parameters.properties.tasks, undefined, 'one task per invocation');
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')).packages, original.packages);
});
