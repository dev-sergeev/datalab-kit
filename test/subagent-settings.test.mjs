import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startKit } from './helpers/kit-session.mjs';

test('explicit user concurrency overrides the default of one without rewriting the config', async t => {
  const original = { maxConcurrent: 3, defaultMaxTurns: 9 };
  const { session, extensionsResult, agentDir } = await startKit(t, original);
  assert.deepEqual(extensionsResult.errors, []);
  const prompts = [];
  await session.bindExtensions({ mode: 'rpc', uiContext: { ...session.extensionRunner.getUIContext(),
    select: async (_title, options) => { prompts.push(options); },
  } });
  await session.extensionRunner.getCommand('subagents:settings').handler('', session.extensionRunner.createCommandContext());
  assert.ok(prompts.flat().includes('Max concurrency (current: 3)'));
  assert.ok(prompts.flat().includes('Default max turns (current: 9)'));
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'subagents.json'), 'utf8')), original);
});
