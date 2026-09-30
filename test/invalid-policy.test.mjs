import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './helpers/session.mjs';

test('malformed user policy cannot silently enable kit read defaults', async t => {
  const { runner } = await start(t, '{bad json');
  const result = await runner.emitToolCall({ type: 'tool_call', toolName: 'read', toolCallId: 'read', input: { path: 'file' } });
  assert.equal(result?.block, true);
});
