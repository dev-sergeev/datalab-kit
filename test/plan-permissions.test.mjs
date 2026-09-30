import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { start } from './helpers/session.mjs';

async function plan(runner, command) {
  const registered = runner.getRegisteredCommands().find(command => command.name === 'plan');
  assert.ok(registered);
  await registered.handler(command, runner.createCommandContext());
}

function call(runner, toolName, input) {
  return runner.emitToolCall({ type: 'tool_call', toolName, toolCallId: JSON.stringify(input), input });
}

test('Plan owns command admission without kit prompts; leaving restores kit defaults', async t => {
  const { runner, prompts } = await start(t, undefined, 'Отмена', { planMode: true });
  assert.equal((await call(runner, 'bash', { command: 'npm test' }))?.block, true);
  const before = prompts.length;
  await plan(runner, 'start');
  for (const command of ['npm test', 'npm run typecheck', 'git status']) {
    assert.notEqual((await call(runner, 'bash', { command }))?.block, true, command);
  }
  for (const toolName of ['plan_mode_question', 'plan_mode_complete']) {
    assert.notEqual((await call(runner, toolName, {}))?.block, true, toolName);
  }
  for (const command of ['rm file', 'npm install', 'cat a > b']) {
    const result = await call(runner, 'bash', { command });
    assert.equal(result?.block, true, command);
    assert.match(result.reason, /Plan mode/);
  }
  assert.equal((await call(runner, 'write', { path: 'file', content: 'text' }))?.block, true);
  assert.equal(prompts.length, before);
  await plan(runner, 'off');
  assert.equal((await call(runner, 'bash', { command: 'npm test' }))?.block, true);
  assert.ok(prompts.length > before);
  const after = prompts.length;
  assert.notEqual((await call(runner, 'bash', { command: 'git status' }))?.block, true);
  assert.equal(prompts.length, after);
});

test('Plan preserves user asks and denies, including nested command and path rules', async t => {
  const { runner, prompts, cwd } = await start(t, { permission: {
    bash: { 'npm test': 'ask', 'git status': 'deny' },
    read: { '*secret*': 'deny' },
    path_read: { '*private*': 'ask' },
  } }, 'Отмена', { planMode: true });
  await plan(runner, 'start');
  assert.equal((await call(runner, 'bash', { command: 'npm test' }))?.block, true);
  assert.equal(prompts.length, 1);
  assert.equal((await call(runner, 'bash', { command: 'git status' }))?.block, true);
  assert.equal((await call(runner, 'bash', { command: 'pwd && git status' }))?.block, true);
  assert.equal((await call(runner, 'read', { path: `${cwd}/secret.txt` }))?.block, true);
  assert.equal(prompts.length, 1);
  assert.equal((await call(runner, 'read', { path: `${cwd}/private.txt` }))?.block, true);
  assert.equal(prompts.length, 2);
  assert.notEqual((await call(runner, 'bash', { command: 'npm run typecheck' }))?.block, true);
  assert.equal(prompts.length, 2);
});

test('user wildcard still asks in Plan mode', async t => {
  const { runner, prompts } = await start(t, { permission: { '*': 'ask' } }, 'Отмена', { planMode: true });
  await plan(runner, 'start');
  assert.equal((await call(runner, 'bash', { command: 'npm test' }))?.block, true);
  assert.equal((await call(runner, 'plan_mode_complete', {}))?.block, true);
  assert.equal(prompts.length, 2);
});

test('invalid user policy fails closed in Plan mode', async t => {
  const { runner, prompts } = await start(t, '{bad json', 'Отмена', { planMode: true });
  await plan(runner, 'start');
  assert.equal((await call(runner, 'bash', { command: 'npm test' }))?.block, true);
  assert.ok(prompts.length > 0);
});

test('restored Plan state delegates defaults and restores approvals on exit', async t => {
  const sessionManager = SessionManager.inMemory('/tmp');
  sessionManager.appendCustomEntry('plan-mode-state', { enabled: true, awaitingAction: false });
  const { runner, prompts } = await start(t, undefined, 'Отмена', { planMode: true, sessionManager });
  assert.notEqual((await call(runner, 'bash', { command: 'npm test' }))?.block, true);
  assert.equal(prompts.length, 0);
  await plan(runner, 'off');
  assert.equal((await call(runner, 'bash', { command: 'npm test' }))?.block, true);
  assert.ok(prompts.length > 0);
});

test('branch changes restore the corresponding permission mode without stale cache', async t => {
  const sessionManager = SessionManager.inMemory('/tmp');
  const { runner, prompts } = await start(t, undefined, 'Отмена', { planMode: true, sessionManager });
  await plan(runner, 'start');
  const planningLeaf = sessionManager.getLeafId();
  await plan(runner, 'off');
  const normalLeaf = sessionManager.getLeafId();
  for (const [leaf, previous, blocked] of [[planningLeaf, normalLeaf, false], [normalLeaf, planningLeaf, true]]) {
    sessionManager.branch(leaf);
    await runner.emit({ type: 'session_tree', newLeafId: leaf, oldLeafId: previous });
    const before = prompts.length;
    assert.equal((await call(runner, 'bash', { command: 'npm test' }))?.block === true, blocked);
    assert.equal(prompts.length > before, blocked);
  }
});

test('saved Plan state cannot bypass permissions when Plan extension is absent', async t => {
  const sessionManager = SessionManager.inMemory('/tmp');
  sessionManager.appendCustomEntry('plan-mode-state', { enabled: true, awaitingAction: false });
  const { runner, prompts } = await start(t, undefined, 'Отмена', { sessionManager });
  assert.equal((await call(runner, 'bash', { command: 'npm test' }))?.block, true);
  assert.ok(prompts.length > 0);
});

test('failed Plan restoration keeps ordinary approvals despite saved enabled state', async t => {
  const sessionManager = SessionManager.inMemory('/tmp');
  sessionManager.appendCustomEntry('plan-mode-state', { enabled: true, awaitingAction: false });
  const { runner, session, prompts } = await start(t, undefined, 'Отмена', { planMode: true, sessionManager });
  session.setActiveToolsByName(['read', 'bash']);
  await runner.emit({ type: 'session_start', reason: 'resume' });
  assert.equal((await call(runner, 'bash', { command: 'npm test' }))?.block, true);
  assert.ok(prompts.length > 0);
});

test('Plan-approved wrappers delegate synthetic builtin asks without changing normal-mode gates', async t => {
  const { runner, prompts } = await start(t, undefined, 'Отмена', {
    planMode: true, planSettings: { safeSubcommands: { env: ['npm'] } },
  });
  await plan(runner, 'start');
  assert.notEqual((await call(runner, 'bash', { command: 'env npm test' }))?.block, true);
  assert.equal(prompts.length, 0);
  await plan(runner, 'off');
  assert.equal((await call(runner, 'bash', { command: 'env npm test' }))?.block, true);
  assert.ok(prompts.length > 0);
});
