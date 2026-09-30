import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './helpers/session.mjs';

test('approval applies to one invocation and the next invocation asks again', async t => {
  const { runner, prompts } = await start(t, undefined, 'Разрешить один раз');
  for (let id = 0; id < 2; id++) {
    const result = await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: String(id), input: { command: 'rm file' } });
    assert.notEqual(result?.block, true);
  }
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map(prompt => prompt[1]), [['Отмена', 'Разрешить один раз'], ['Отмена', 'Разрешить один раз']]);
});
