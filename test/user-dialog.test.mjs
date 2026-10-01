import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './helpers/session.mjs';

for (const config of [undefined, { doublePressToConfirm: false }, { doublePressToConfirm: true }]) {
  test(`stock permission dialog is used with preferences ${JSON.stringify(config)}`, async t => {
    const { runner, prompts } = await start(t, config);
    const result = await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'rm', input: { command: 'rm file' } });
    assert.equal(result?.block, true);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0][1].includes('Yes'));
    assert.ok(prompts[0][1].includes('No'));
    assert.ok(prompts[0][1].some(option => option.includes('for this session')));
    assert.ok(prompts[0][1].includes('No, provide reason'));
    assert.ok(!prompts[0][1].includes('Разрешить один раз'));
  });
}
