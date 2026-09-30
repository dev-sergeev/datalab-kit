import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './helpers/session.mjs';

test('explicit user dialog preferences preserve the upstream confirmation UI', async t => {
  const { runner, prompts } = await start(t, { doublePressToConfirm: false });
  await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'rm', input: { command: 'rm file' } });
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0][1].includes('Yes'));
  assert.ok(!prompts[0][1].includes('Разрешить один раз'));
});
