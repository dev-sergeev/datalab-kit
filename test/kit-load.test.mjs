import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startKit } from './helpers/kit-session.mjs';

test('kit components load in Pi and preserve the selected provider and model', async t => {
  const { session, extensionsResult, agentDir, original } = await startKit(t);
  assert.deepEqual(extensionsResult.errors, []);
  const tools = session.getAllTools().map(tool => tool.name);
  assert.ok(tools.includes('subagent'));
  assert.ok(tools.includes('ask_user_question'));
  assert.ok(tools.some(name => name.includes('todo')));
  await session.bindExtensions({ mode: 'rpc' });
  const subagent = session.getAllTools().find(tool => tool.name === 'subagent');
  assert.equal(subagent.parameters.properties.prompt.type, 'string');
  assert.equal(subagent.parameters.properties.tasks, undefined, 'one task per invocation');
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')), original);
});
