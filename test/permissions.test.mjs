import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './helpers/session.mjs';

test('операции чтения in any directory need no approval; writes and external commands do', async t => {
  const { runner, prompts } = await start(t);
  for (const toolName of ['read', 'ls', 'grep', 'find']) {
    const result = await runner.emitToolCall({ type: 'tool_call', toolName, toolCallId: toolName,
      input: { path: '/tmp/outside-project', pattern: 'text' } });
    assert.notEqual(result?.block, true, toolName);
  }
  for (const command of ['cat /tmp/outside-project', 'ls /tmp', 'grep text /tmp/file', 'find /tmp -type f', 'curl http://localhost:8080/data']) {
    const result = await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: command, input: { command } });
    assert.notEqual(result?.block, true, command);
  }
  assert.equal(prompts.length, 0);
  for (const command of ['rm file', 'hadoop version', 'hdfs dfs -ls /', 'curl https://example.com', 'curl -X DELETE http://localhost:8080/data', 'cat a > b', 'find /tmp -delete', 'npm install', 'git commit -m test', 'cat a && rm a']) {
    const result = await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: command, input: { command } });
    assert.equal(result?.block, true, command);
  }
  for (const toolName of ['write', 'edit']) {
    assert.equal((await runner.emitToolCall({ type: 'tool_call', toolName, toolCallId: toolName,
      input: { path: '/tmp/outside-project', content: 'text', oldText: 'a', newText: 'b' } }))?.block, true);
  }
  assert.ok(prompts.length >= 12);
  assert.ok(prompts[0][1].includes('Yes'));
  assert.ok(prompts[0][1].includes('No'));
  assert.ok(prompts[0][1].some(option => option.includes('for this session')));
});

