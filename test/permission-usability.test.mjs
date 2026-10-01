import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { start } from './helpers/session.mjs';

const inspections = [
  'grep foo file | head', 'grep foo *.ts | head -20',
  "grep -R 'foo.*bar' . | head", 'grep [a-z] *.txt | head',
  'rg -- foo *.ts | head -20', 'rg foo src/*.ts | head',
  'ls *.ts', 'cat ./data/*.txt | head', "find . -name '*.ts' | head",
  'fd --extension ts . | head', 'sort -- *.txt | head', 'sort ./data/*.txt | head',
  'grep foo file || head file', 'pwd && ls /tmp', 'pwd; cat /etc/hosts',
  'pwd\nls /tmp', '# inspection\ngrep foo file | head # end',
  'grep foo file 2>&1 | head', 'rg foo src 2>/dev/null | head',
  'cat < /etc/hosts | head', 'cat file > /dev/null',
  "grep 'a|b' file", 'grep a\\|b file', 'grep "[a-z]+" file | head',
  'grep foo \\\nfile | head', 'git status', 'git diff -- src/file.ts',
  'rg -- --pre=sh', 'sort -- -ooutput', 'sort --check file', '', '  # no operation',
];
const changes = [
  'grep foo file | head > output', 'grep foo file | tee output',
  'cat file >> output', 'cat file 2> errors', 'cat file &> output',
  'grep foo file | head && rm file', 'cat file; git push',
  'cat $(rm file)', 'cat `rm file`', 'cat <(rm file)', 'cat file > >(rm file)',
  'cat "$COMMAND"', 'cat ${FILE}', 'cat file &', 'cat file\u0000',
  'find . -delete', 'find . -exec rm {} \\;', 'find . -execdir sh -c x \\;',
  'fd -x rm', 'fd --exec sh', 'rg --pre sh foo', 'rg --pre=sh foo',
  'sort -o output input', 'sort -uooutput input', 'sort --out=output input',
  'sort --compress-program=sh input', 'sort --compress=sh input',
  'diff --output=output a b', 'git diff --output=output',
  'git diff --ext-diff', 'git diff --ext-dif', 'git show --textcon', 'git show --textconv', 'npm install', 'git commit -m test',
  'curl https://example.com', 'curl -X DELETE http://localhost',
  // Expansion could inject an executable/output option from a filename.
  'rg foo *', 'sort *', 'find *', 'find -- *', 'fd *',
  's*rt input', 'bash -c "cat file"', 'env cat file',
  'git < status push', 'git < log commit', 'sort < -- -o/tmp/output',
  'rg < -- --pre=sh foo file', 'diff < -- --output=/tmp/output a b',
  'PATH=/tmp/untrusted cat file', 'GIT_EXTERNAL_DIFF=sh git diff',
];

function call(runner, toolName, input) {
  return runner.emitToolCall({ type: 'tool_call', toolName, toolCallId: JSON.stringify(input), input });
}
async function yolo(runner, value) {
  await runner.getCommand('yolo').handler(value, runner.createCommandContext());
}

test('inspection matrix crosses real permission gates without false prompts', async t => {
  const { runner, prompts } = await start(t);
  for (const command of inspections) {
    const before = prompts.length;
    assert.notEqual((await call(runner, 'bash', { command }))?.block, true, command);
    assert.equal(prompts.length, before, command);
  }
});

test('writes, nested execution, external mutation and option injection still prompt', async t => {
  const { runner, prompts } = await start(t);
  for (const command of changes) {
    const before = prompts.length;
    assert.equal((await call(runner, 'bash', { command }))?.block, true, command);
    assert.ok(prompts.length > before, command);
  }
});

test('read-only prefixes and pipelines cannot hide a modifying operation', async t => {
  const { runner, prompts } = await start(t);
  for (const prefix of ['echo checking', 'grep foo *.ts | head', 'git status']) {
    for (const operator of [' && ', ' | ']) {
      for (const change of changes) {
        const command = prefix + operator + change;
        const before = prompts.length;
        assert.equal((await call(runner, 'bash', { command }))?.block, true, command);
        assert.ok(prompts.length > before, command);
      }
    }
  }
});

test('reader improvements respect explicit asks, nested denies and path rules', async t => {
  const { runner, prompts, cwd } = await start(t, { permission: {
    bash: { 'grep *': 'ask', 'rm *': 'deny', 'git push': 'deny' },
    path_read: { '*secret*': 'deny' },
  } });
  assert.equal((await call(runner, 'bash', { command: 'grep foo *.ts | head' }))?.block, true);
  assert.equal(prompts.length, 1);
  for (const command of ['cat a && rm a', 'cat a | head; git push', `cat ${cwd}/secret.txt | head`]) {
    const before = prompts.length;
    assert.equal((await call(runner, 'bash', { command }))?.block, true, command);
    assert.equal(prompts.length, before, command);
  }
});

test('existing bare files and symlink aliases retain their user path restrictions', async t => {
  const { runner, prompts, cwd } = await start(t, { permission: { path_read: { '*secret*': 'deny' } } });
  await writeFile(join(cwd, 'ordinary.txt'), 'ordinary');
  await writeFile(join(cwd, 'secret.txt'), 'secret');
  await symlink(join(cwd, 'secret.txt'), join(cwd, 'alias.txt'));
  assert.notEqual((await call(runner, 'bash', { command: 'cat ordinary.txt | head' }))?.block, true);
  assert.equal((await call(runner, 'bash', { command: 'cat alias.txt | head' }))?.block, true);
  assert.equal(prompts.length, 0);
});

test('expanded globs respect user path denies, cd bases and symlink aliases', async t => {
  const { runner, prompts, cwd } = await start(t, { permission: { path_read: { '*secret*': 'deny' } } });
  await mkdir(join(cwd, 'data'));
  await writeFile(join(cwd, 'data/public.ts'), 'public');
  await writeFile(join(cwd, 'data/secret.ts'), 'secret');
  await symlink(join(cwd, 'data/secret.ts'), join(cwd, 'alias.ts'));
  for (const command of ['grep foo data/*.ts | head', 'cd data && grep foo *.ts | head', 'cat *.ts | head', 'grep data/*.ts ordinary.txt']) {
    assert.equal((await call(runner, 'bash', { command }))?.block, true, command);
  }
  assert.equal(prompts.length, 0);
  assert.notEqual((await call(runner, 'bash', { command: 'cat data/pub*.ts | head' }))?.block, true);
  await yolo(runner, 'on');
  assert.equal((await call(runner, 'bash', { command: 'cat data/*.ts | head' }))?.block, true);
  assert.equal(prompts.length, 0);
});

test('explicit user grants compose with read-only preambles without builtin false prompts', async t => {
  const { runner, prompts } = await start(t, { permission: { bash: { 'npm test': 'allow' } } });
  assert.notEqual((await call(runner, 'bash', { command: 'echo checking && npm test' }))?.block, true);
  assert.equal(prompts.length, 0);
});

test('real todo creation and updates need no kit approvals; explicit user rules still win', async t => {
  const { runner, session, prompts } = await start(t, undefined, 'Отмена', { todo: true });
  const tool = runner.getToolDefinition('todo');
  const tasks = [{ key: 'inspect', subject: 'Проверить поведение', status: 'in_progress' }];
  assert.notEqual((await call(runner, 'todo', { tasks }))?.block, true);
  const result = await tool.execute('todo-create', { tasks }, undefined, undefined, runner.createContext());
  assert.equal(result.details.tasks[0].subject, tasks[0].subject);
  const done = { tasks: [{ key: 'inspect', status: 'completed' }], baseVersion: result.details.version };
  assert.notEqual((await call(runner, 'todo', done))?.block, true);
  assert.equal((await tool.execute('todo-update', done, undefined, undefined, runner.createContext())).details.tasks[0].status, 'completed');
  assert.equal(prompts.length, 0);
});

for (const policy of ['ask', 'deny']) test(`explicit todo ${policy} overrides kit allow`, async t => {
  const { runner, prompts } = await start(t, { permission: { todo: policy } }, 'Отмена', { todo: true });
  assert.equal((await call(runner, 'todo', { tasks: [] }))?.block, true);
  assert.equal(prompts.length, policy === 'ask' ? 1 : 0);
});

test('session YOLO approves asks and synthetic gates, preserves denies, and off restores prompts', async t => {
  const { runner, prompts, statuses, notices, agentDir } = await start(t, { permission: { bash: { 'git push': 'deny' } } });
  const path = join(agentDir, 'extensions/pi-permission-system/config.json');
  const original = await readFile(path, 'utf8');
  assert.ok(runner.getCommand('yolo'));
  await yolo(runner, 'status');
  assert.match(notices.at(-1)[0], /YOLO off/);
  await yolo(runner, 'on');
  assert.equal(statuses.get('pi-permission-system'), 'yolo');
  await runner.emitInput('continue', undefined, 'interactive');
  assert.equal(statuses.get('pi-permission-system'), 'yolo');
  await runner.emitBeforeAgentStart('continue', undefined, 'system', {});
  assert.equal(statuses.get('pi-permission-system'), 'yolo');
  for (const command of ['rm file', 'npm install', 'bash -c "rm file"', 'cat $(rm file)']) {
    assert.notEqual((await call(runner, 'bash', { command }))?.block, true, command);
  }
  assert.equal((await call(runner, 'bash', { command: 'cat a && git push' }))?.block, true);
  assert.equal(prompts.length, 0);
  assert.equal(await readFile(path, 'utf8'), original);
  await yolo(runner, 'off');
  assert.equal(statuses.get('pi-permission-system'), undefined);
  await runner.emitInput('continue', undefined, 'interactive');
  assert.equal(statuses.get('pi-permission-system'), undefined);
  await runner.emitBeforeAgentStart('continue', undefined, 'system', {});
  assert.equal(statuses.get('pi-permission-system'), undefined);
  assert.equal((await call(runner, 'bash', { command: 'rm file' }))?.block, true);
  assert.ok(prompts.length > 0);
  assert.equal(await readFile(path, 'utf8'), original);
  await yolo(runner, 'unknown');
  assert.match(notices.at(-1)[0], /Usage/);
});

test('session off overrides persistent YOLO without rewriting it, and new session resets override', async t => {
  const { runner, statuses, prompts, agentDir } = await start(t, { yoloMode: true });
  assert.equal(statuses.get('pi-permission-system'), 'yolo');
  await yolo(runner, 'off');
  assert.equal((await call(runner, 'bash', { command: 'rm file' }))?.block, true);
  assert.equal(statuses.get('pi-permission-system'), undefined);
  const config = JSON.parse(await readFile(join(agentDir, 'extensions/pi-permission-system/config.json'), 'utf8'));
  assert.equal(config.yoloMode, true);
  await runner.emit({ type: 'session_start', reason: 'new' });
  const before = prompts.length;
  assert.notEqual((await call(runner, 'bash', { command: 'rm file' }))?.block, true);
  assert.equal(prompts.length, before);
  assert.equal(statuses.get('pi-permission-system'), 'yolo');
});

test('YOLO remains off in a new session by default and cannot loosen Plan mode', async t => {
  const { runner, prompts, statuses } = await start(t, undefined, 'Отмена', { planMode: true });
  await yolo(runner, 'on');
  await runner.getCommand('plan').handler('start', runner.createCommandContext());
  assert.equal((await call(runner, 'bash', { command: 'rm file' }))?.block, true);
  assert.equal(prompts.length, 0);
  await runner.getCommand('plan').handler('off', runner.createCommandContext());
  assert.notEqual((await call(runner, 'bash', { command: 'rm file' }))?.block, true);
  await runner.emit({ type: 'session_start', reason: 'new' });
  assert.equal(statuses.get('pi-permission-system'), undefined);
  assert.equal((await call(runner, 'bash', { command: 'rm file' }))?.block, true);
  assert.ok(prompts.length > 0);
});

test('malformed policy still asks in normal mode; explicit YOLO opts into approving those asks', async t => {
  const { runner, prompts } = await start(t, '{bad json');
  assert.equal((await call(runner, 'bash', { command: 'grep foo *.ts | head' }))?.block, true);
  await yolo(runner, 'on');
  const before = prompts.length;
  assert.notEqual((await call(runner, 'bash', { command: 'rm file' }))?.block, true);
  assert.equal(prompts.length, before);
});

test('YOLO preserves user path and tool denies while approving explicit asks', async t => {
  const { runner, prompts, cwd } = await start(t, { permission: {
    bash: 'ask', todo: 'deny', path_write: { '*secret*': 'deny' },
  } }, 'Отмена', { todo: true });
  await yolo(runner, 'on');
  assert.notEqual((await call(runner, 'bash', { command: 'npm install' }))?.block, true);
  assert.equal((await call(runner, 'write', { path: `${cwd}/secret.txt`, content: 'x' }))?.block, true);
  assert.equal((await call(runner, 'todo', { tasks: [] }))?.block, true);
  assert.equal(prompts.length, 0);
});
