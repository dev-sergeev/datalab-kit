import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './helpers/session.mjs';

test('explicit user policy overrides kit defaults', async t => {
  const { runner, prompts } = await start(t, { permission: { read: 'deny', bash: 'ask' } });
  assert.equal((await runner.emitToolCall({ type: 'tool_call', toolName: 'read', toolCallId: 'read', input: { path: 'file' } }))?.block, true);
  assert.equal((await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'cat', input: { command: 'cat file' } }))?.block, true);
  assert.equal(prompts.length, 1);
});
