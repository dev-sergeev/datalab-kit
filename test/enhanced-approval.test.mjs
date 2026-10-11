import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './helpers/session.mjs';
import { writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti';
import { resolve } from 'node:path';
import { agentSandbox } from './helpers/agent-sandbox.mjs';

const call = (runner, command, id = command) => runner.emitToolCall({
  type: 'tool_call', toolName: 'bash', toolCallId: id, input: { command },
});

test('dangerous deletion needs typed yes even when ordinary approval and YOLO allow it', async t => {
  const { runner, prompts, typedPrompts } = await start(t,
    { yoloMode: true, permission: { '*': 'allow' } }, 'Yes', { typedAnswer: '' });
  assert.equal((await call(runner, 'rm file'))?.block, true);
  assert.equal(prompts.length, 0);
  assert.equal(typedPrompts.length, 1);
});

test('one whole protected invocation gets fresh typed approval and never a normal or session grant', async t => {
  let answer = 'yes';
  const { runner, prompts, typedPrompts } = await start(t, { permission: { '*': 'ask' } },
    'Yes, for this session', { typedAnswer: () => answer });
  const command = 'rm first && hdfs dfs -ls /shared && psql -X -c "UPDATE accounts SET active=false"';
  assert.notEqual((await call(runner, command, 'first'))?.block, true);
  assert.equal(typedPrompts.length, 1);
  assert.ok(typedPrompts[0][0].includes(command));
  answer = undefined;
  assert.equal((await call(runner, command, 'second'))?.block, true);
  assert.equal(typedPrompts.length, 2);
  assert.equal(prompts.length, 0);
});

test('config-only shell and canonical path denies veto direct and recovered commands before typed UI', async t => {
  const { runner, prompts, typedPrompts, cwd } = await start(t, { yoloMode: true, permission: {
    bash: { '*': 'allow', 'rm blocked.txt': 'deny' }, path_write: { '*secret*': 'deny' },
  } }, 'Yes', { typedAnswer: 'yes' });
  await writeFile(join(cwd, 'secret.txt'), 'keep');
  await symlink(join(cwd, 'secret.txt'), join(cwd, 'alias.txt'));
  for (const command of [
    'rm blocked.txt', 'bash -c "rm blocked.txt"', "psql -X -c '\\! rm blocked.txt'",
    'rm alias.txt', 'bash -c "rm alias.txt"', "psql -X -c '\\! rm alias.txt'",
  ]) {
    assert.equal((await call(runner, command))?.block, true, command);
  }
  assert.equal(prompts.length, 0);
  assert.equal(typedPrompts.length, 0);
});

test('an existing native session grant cannot approve a protected nested invocation', async t => {
  const { runner, prompts, typedPrompts } = await start(t, { permission: { bash: 'ask' } },
    (_title, options) => options.find(option => option.includes('for this session')), { typedAnswer: undefined });
  assert.notEqual((await call(runner, 'bash -c "npm install"', 'grant'))?.block, true);
  const ordinaryPrompts = prompts.length;
  assert.notEqual((await call(runner, 'bash -c "npm install"', 'reuse'))?.block, true);
  assert.equal(prompts.length, ordinaryPrompts);
  assert.equal((await call(runner, 'bash -c "rm file"', 'protected'))?.block, true);
  assert.equal(typedPrompts.length, 1);
  assert.equal(prompts.length, ordinaryPrompts);
});

test('Plan and explicit deny remain final even if the human would type yes', async t => {
  const { runner, prompts, typedPrompts } = await start(t, { yoloMode: true, permission: { '*': 'allow' } },
    'Yes', { planMode: true, typedAnswer: 'yes' });
  await runner.getCommand('plan').handler('start', runner.createCommandContext());
  assert.equal((await call(runner, 'rm file'))?.block, true);
  assert.equal(typedPrompts.length, 0);
  await runner.getCommand('plan').handler('off', runner.createCommandContext());
  assert.notEqual((await call(runner, 'rm file'))?.block, true);
  assert.equal(typedPrompts.length, 1);
  assert.equal(prompts.length, 0);
});

test('opaque scripts, unsupported SQL surfaces and ordinary asks keep the native path', async t => {
  const { runner, prompts, typedPrompts } = await start(t, { permission: { '*': 'ask' } }, 'Yes',
    { typedAnswer: undefined });
  for (const command of ['npm install', 'bash operation.sh', "python -c 'import os; os.remove(\"file\")'",
    '$UNKNOWN_EXECUTABLE file', 'mysql -e "DELETE FROM accounts"']) {
    assert.notEqual((await call(runner, command))?.block, true, command);
  }
  assert.ok(prompts.length > 0);
  assert.equal(typedPrompts.length, 0);
});

test('changing any tool input while the human approves invalidates the approval', async t => {
  const input = { command: 'rm first', timeout: 10 };
  const { runner, prompts } = await start(t, { permission: { '*': 'allow' } }, 'Yes', {
    typedAnswer: () => { input.command = 'rm different'; return 'yes'; },
  });
  const result = await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'changed', input });
  assert.equal(result?.block, true);
  assert.equal(prompts.length, 0);
});

test('missing integration blocks tools independently of upstream permissions and restores no unsafe fallback', async t => {
  const { runner, typedPrompts, prompts } = await start(t, { permission: { '*': 'allow' } }, 'Yes', {
    permissionSystem: false, typedAnswer: 'yes',
  });
  assert.equal((await call(runner, 'rm file'))?.block, true);
  assert.equal((await runner.emitToolCall({
    type: 'tool_call', toolName: 'read', toolCallId: 'read', input: { path: 'file' },
  }))?.block, true);
  assert.equal(typedPrompts.length, 0);
  assert.equal(prompts.length, 0);
});

test('native subagent forwarding respects the actual parent Plan policy before the human prompt', async t => {
  const sandbox = await agentSandbox(t);
  const parentManager = SessionManager.inMemory('/tmp');
  const childManager = SessionManager.inMemory('/tmp');
  const parent = await start(t, { yoloMode: true, permission: { '*': 'allow' } }, 'Yes', {
    planMode: true, sessionManager: parentManager, typedAnswer: 'yes', sandbox,
    planSettings: { safeSubcommands: { hdfs: ['dfs'] } },
  });
  const { getSubagentSessionRegistry } = await createJiti(import.meta.url).import(
    resolve('node_modules/@gotgenes/pi-permission-system/src/authority/subagent-registry.ts'));
  const registry = getSubagentSessionRegistry();
  registry.register(childManager.getSessionId(), { parentSessionId: parentManager.getSessionId() });
  t.after(() => registry.unregister(childManager.getSessionId()));
  const child = await start(t, { yoloMode: true, permission: { '*': 'allow' } }, 'Yes', {
    sessionManager: childManager, typedAnswer: 'yes', sandbox,
  });
  await parent.runner.getCommand('plan').handler('start', parent.runner.createCommandContext());
  assert.notEqual((await call(child.runner, 'hdfs dfs -ls /shared'))?.block, true);
  assert.equal(parent.typedPrompts.length, 1);
  assert.equal((await call(child.runner, 'rm file'))?.block, true);
  assert.equal(parent.typedPrompts.length, 1);
  await parent.runner.getCommand('plan').handler('off', parent.runner.createCommandContext());
  assert.notEqual((await call(child.runner, 'rm file', 'after-plan'))?.block, true);
  assert.equal(parent.typedPrompts.length, 2);
  assert.equal(child.typedPrompts.length, 0);
  assert.equal(parent.prompts.length + child.prompts.length, 0);
});

test('a final command redirect cannot make an earlier SQL command substitution read-only', async t => {
  const { runner, cwd, typedPrompts } = await start(t, { yoloMode: true, permission: { '*': 'allow' } },
    'Yes', { typedAnswer: undefined });
  await writeFile(join(cwd, 'read.sql'), 'SELECT 1;\n');
  assert.equal((await call(runner, 'printf "%s" "$(psql -X)" < read.sql'))?.block, true);
  assert.equal(typedPrompts.length, 1);
  assert.notEqual((await call(runner, '{ printf "%s" "$(psql -X)"; } < read.sql'))?.block, true);
  assert.equal(typedPrompts.length, 1);
});

test('known native executors cannot hide protected operations behind ordinary YOLO', async t => {
  const { runner, typedPrompts, prompts } = await start(t, { yoloMode: true, permission: { '*': 'allow' } });
  const commands = [
    'flock -w 1 /tmp/lock rm -f victim',
    'setsid hdfs dfs -ls /',
    'watch -n 1 "hadoop version"',
    "parallel 'rm {}' ::: victim",
    'fd --exec rm {}',
    'command rm -v victim',
    'sudo rm -v victim',
    'f() { rm victim; }; command eval f',
    'f() { rm victim; }; builtin eval f',
    'TARGET=victim; watch rm "$TARGET"',
    'TARGET=victim; parallel rm "$TARGET" ::: item',
    "flock /tmp/lock --command='rm victim'",
  ];
  for (const command of commands) assert.equal((await call(runner, command))?.block, true, command);
  assert.equal(typedPrompts.length, commands.length);
  assert.equal(prompts.length, 0);
});

test('raw command deny applies to normalized recovered argv before any yes input', async t => {
  const { runner, typedPrompts } = await start(t, {
    yoloMode: true, permission: { '*': 'allow', bash: { '*': 'allow', 'rm blocked.txt': 'deny' } },
  }, 'Yes', { typedAnswer: 'yes' });
  for (const command of ['sudo rm blocked.txt', "env -S 'rm blocked.txt'", 'setsid rm blocked.txt']) {
    assert.equal((await call(runner, command))?.block, true, command);
  }
  assert.equal(typedPrompts.length, 0);
});

test('background directory changes cannot make a later mutating SQL file appear read-only', async t => {
  const { runner, cwd, typedPrompts } = await start(t, { yoloMode: true, permission: { '*': 'allow' } });
  const safe = join(cwd, 'safe');
  await mkdir(safe);
  await writeFile(join(cwd, 'query.sql'), 'DELETE FROM records;\n');
  await writeFile(join(safe, 'query.sql'), 'SELECT 1;\n');
  assert.equal((await call(runner, `cd '${safe}' & wait; psql -X -f query.sql`))?.block, true);
  assert.equal(typedPrompts.length, 1);
  assert.notEqual((await call(runner, `cd '${safe}'; { psql -X -f query.sql; } & wait`))?.block, true);
  assert.equal(typedPrompts.length, 1, 'a background child inherits the preceding foreground cwd');
});

test('git clean remains protected when external configuration disables the force requirement', async t => {
  const { runner, typedPrompts } = await start(t, { yoloMode: true, permission: { '*': 'allow' } });
  const command = 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=clean.requireForce GIT_CONFIG_VALUE_0=false git clean -d';
  assert.equal((await call(runner, command))?.block, true);
  assert.equal(typedPrompts.length, 1);
  assert.notEqual((await call(runner, `${command} -n`))?.block, true);
  assert.equal(typedPrompts.length, 1, 'a proven dry run stays ordinary even with force disabled');
});

test('current-shell builtin wrappers change SQL cwd but process wrappers cannot change the caller cwd', async t => {
  const { runner, cwd, typedPrompts } = await start(t, { yoloMode: true, permission: { '*': 'allow' } });
  const safe = join(cwd, 'safe');
  await mkdir(safe);
  await writeFile(join(cwd, 'query.sql'), 'DELETE FROM records;\n');
  await writeFile(join(safe, 'query.sql'), 'SELECT 1;\n');
  assert.equal((await call(runner, `env eval "cd '${safe}'"; psql -X -f query.sql`))?.block, true);
  assert.notEqual((await call(runner, `builtin cd '${safe}'; psql -X -f query.sql`))?.block, true);
  await writeFile(join(cwd, 'query.sql'), 'SELECT 1;\n');
  await writeFile(join(safe, 'query.sql'), 'DELETE FROM records;\n');
  assert.equal((await call(runner, `command cd '${safe}'; psql -X -f query.sql`))?.block, true);
  assert.equal(typedPrompts.length, 2);
});

test('raw deletion-family deny applies even when a known executor supplies unknown operands', async t => {
  const { runner, typedPrompts } = await start(t, {
    yoloMode: true, permission: { '*': 'allow', bash: { '*': 'allow', 'rm *': 'deny' } },
  }, 'Yes', { typedAnswer: 'yes' });
  for (const command of ['sudo rm "$TARGET"', 'fd --exec rm {}']) assert.equal((await call(runner, command))?.block, true);
  assert.equal(typedPrompts.length, 0);
});

test('supported SQL follows executor cwd while result substitutions and execdir remain unknown', async t => {
  const { runner, cwd, typedPrompts } = await start(t, { yoloMode: true, permission: { '*': 'allow' } });
  const target = join(cwd, 'target');
  await mkdir(target);
  await writeFile(join(cwd, 'query.sql'), 'SELECT 1;\n');
  await writeFile(join(target, 'query.sql'), 'DELETE FROM records;\n');
  assert.equal((await call(runner, `fd --exec=psql -X -f query.sql \\; --base-directory='${target}'`))?.block, true);
  assert.equal((await call(runner, 'fd --exec psql -X -c "SELECT 1" {}'))?.block, true);
  assert.equal((await call(runner, 'find . -execdir psql -X -f query.sql \\;'))?.block, true);
  assert.equal(typedPrompts.length, 3);
});

test('generated executor arguments cannot make supported SQL look statically read-only', async t => {
  const { runner, typedPrompts } = await start(t, { yoloMode: true, permission: { '*': 'allow' } });
  for (const command of [
    "xargs psql -X -c 'SELECT 1'",
    "parallel psql -X -c 'SELECT 1' ::: item",
    "rush \"psql -X -c 'SELECT 1'\"",
    "fd --exec psql -X -c 'SELECT 1'",
  ]) assert.equal((await call(runner, command))?.block, true, command);
  assert.equal(typedPrompts.length, 4);
  assert.notEqual((await call(runner, "find . -exec psql -X -c 'SELECT 1' \\;"))?.block, true);
  assert.equal(typedPrompts.length, 4, 'find does not implicitly append generated arguments');
});

test('Git work-tree and tracked quoted operands cannot bypass applicable path vetoes', async t => {
  const { runner, cwd, typedPrompts } = await start(t, {
    yoloMode: true, permission: { '*': 'allow', path_write: { '*secret*': 'deny' } },
  }, 'Yes', { typedAnswer: 'yes' });
  const secret = join(cwd, 'secret-repo');
  await mkdir(secret);
  await writeFile(join(cwd, 'secret.txt'), 'keep');
  for (const command of [
    `git -C '${cwd}' --work-tree='${secret}' clean -fd`,
    `git --work-tree='${secret}' clean -fd`,
    `git --work-tree '${secret}' clean -fd`,
    'TARGET=secret.txt; rm "$TARGET"',
    'TARGET=secret.txt; rm "${TARGET}"',
    'TARGET=secret.txt; TARGET=safe.txt rm "$TARGET"',
    'TARGET=secret.txt; env TARGET=safe.txt rm "$TARGET"',
    'TARGET=secret.txt; env -S "rm" "$TARGET"',
    'TARGET=secret.txt; find . -exec rm "$TARGET" \\;',
    `TARGET='${join(cwd, 'secret.txt')}'; fd --exec rm "$TARGET"`,
    'TARGET=secret.txt; watch rm "$TARGET"',
    `TARGET='${join(cwd, 'secret.txt')}'; parallel rm "$TARGET" ::: item`,
  ]) assert.equal((await call(runner, command))?.block, true, command);
  assert.equal(typedPrompts.length, 0, 'path veto must run before the human can approve');
  assert.notEqual((await call(runner, 'TARGET=safe.txt; rm "$TARGET"'))?.block, true);
  assert.equal(typedPrompts.length, 1);
});
