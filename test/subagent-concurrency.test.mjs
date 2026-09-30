import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJiti } from 'jiti/static';
import { setImmediate as tick } from 'node:timers/promises';

test('background, foreground and resumed agents share one admission limit', { timeout: 10_000 }, async t => {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const { SubagentManager } = await jiti.import('../node_modules/@gotgenes/pi-subagents/src/lifecycle/subagent-manager.ts');
  const { ConcurrencyLimiter } = await jiti.import('../node_modules/@gotgenes/pi-subagents/src/lifecycle/concurrency-limiter.ts');
  const started = [];
  const completions = new Map();
  let stopping = false;
  const result = { responseText: 'done', aborted: false, steered: false };
  const run = async prompt => {
    started.push(prompt);
    if (stopping) return result;
    await new Promise(resolve => completions.set(prompt, resolve));
    return result;
  };
  const manager = new SubagentManager({
    baseCwd: process.cwd(), limiter: new ConcurrencyLimiter(() => 1),
    registry: { resolveType: name => name, isValidType: () => true, resolveAgentConfig: () => ({}) },
    createSubagentSession: async () => ({
      subscribe: () => () => {}, runTurnLoop: run, resumeTurnLoop: async prompt => (await run(prompt)).responseText,
      dispose: async () => {},
    }),
  });
  t.after(async () => {
    stopping = true;
    manager.abortAll();
    for (const finish of completions.values()) finish();
    await manager.dispose();
  });
  const background = { description: 'test', background: { kind: 'explicit', isBackground: true } };
  const id = manager.spawn({}, 'agent', 'background', background);
  const foreground = manager.spawnAndWait({}, 'agent', 'foreground', { description: 'test' });
  await tick();
  assert.deepEqual(started, ['background']);
  completions.get('background')();
  await tick();
  assert.deepEqual(started, ['background', 'foreground']);
  completions.get('foreground')();
  await foreground;
  await tick();
  manager.spawn({}, 'agent', 'next-background', background);
  const resumed = manager.resume(id, 'resumed');
  await tick();
  assert.deepEqual(started, ['background', 'foreground', 'next-background']);
  completions.get('next-background')();
  await tick();
  assert.equal(started.at(-1), 'resumed');
  completions.get('resumed')();
  assert.equal((await resumed).kind, 'resumed');
});
