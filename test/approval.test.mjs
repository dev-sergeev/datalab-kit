import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './helpers/session.mjs';

test('approval applies to one invocation and the next invocation asks again', async t => {
  const { runner, prompts } = await start(t, undefined, 'Yes');
  for (let id = 0; id < 2; id++) {
    const result = await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: String(id), input: { command: 'rm file' } });
    assert.notEqual(result?.block, true);
  }
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every(prompt => prompt[1].includes('Yes') && prompt[1].includes('No')));
});

test('stock session approval avoids repeated asks and a new session asks again', async t => {
  const { runner, prompts, session } = await start(t, undefined, (_title, options) => options.find(option => option.startsWith('Yes') && option.includes('for this session')));
  const call = id => runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: String(id), input: { command: 'rm file' } });
  assert.notEqual((await call(1))?.block, true);
  assert.equal(prompts.length, 1);
  assert.notEqual((await call(2))?.block, true);
  assert.equal(prompts.length, 1);
  await runner.emit({ type: 'session_shutdown', reason: 'new' });
  session.sessionManager.newSession();
  await runner.emit({ type: 'session_start', reason: 'new' });
  assert.notEqual((await call(3))?.block, true);
  assert.equal(prompts.length, 2);
});

test('a stock session grant does not approve unrelated modifying commands', async t => {
  const { runner, prompts } = await start(t, undefined, (_title, options) => options.find(option => option.startsWith('Yes') && option.includes('for this session')));
  for (const command of ['rm file', 'npm install']) {
    assert.notEqual((await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: command, input: { command } }))?.block, true);
  }
  assert.equal(prompts.length, 2);
});
