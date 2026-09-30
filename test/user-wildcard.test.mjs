import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './helpers/session.mjs';

test('explicit user wildcard applies before kit defaults, including safety settings', async t => {
  const { runner, prompts } = await start(t, { permission: { '*': 'allow' } });
  const result = await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'rm', input: { command: 'rm file' } });
  assert.notEqual(result?.block, true);
  assert.equal(prompts.length, 0);
});
