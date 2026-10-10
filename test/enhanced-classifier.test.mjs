import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyDangerousCommand } from '../dist/enhanced-classifier.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const context = { cwd: '/tmp' };

test('enhanced approval distinguishes executable deletion from shell data', async () => {
  assert.equal((await classifyDangerousCommand('/bin/rm -rf archive', context)).approval, 'enhanced');
  for (const command of ['echo rm -rf archive', '# rm -rf archive\necho safe', "python -c 'print(\"rm -rf archive\")'"]) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'ordinary', command);
  }
});

test('protected command options cover deletion and Hadoop without flagging dry runs', async () => {
  for (const command of ['find . -delete', 'find . -exec rm {} \\;', 'git -C /tmp clean -fd', 'rsync --delete-delay a/ b/', 'rsync --del a/ b/', 'hadoop version', '/opt/bin/hdfs dfs -ls /']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
  }
  for (const command of ['find . -name rm', 'git clean -nd', 'git clean -f --dry-run', 'rsync --dry-run --delete a/ b/', 'git status']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'ordinary', command);
  }
});

test('transparent wrappers and static nested shells preserve executable policy commands', async () => {
  for (const command of ['sudo -u root /bin/rm old', 'env LANG=C nice -n 5 rm old', 'timeout 5s sh -c "hdfs dfs -ls /"', "eval 'rm old'", 'echo "$(unlink old)"', 'rm old && hadoop version']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
  }
  const nested = await classifyDangerousCommand("sh -c 'rm old; hdfs dfs -ls /'", context);
  assert.ok(nested.commands.some(command => command.startsWith('rm old')));
  assert.ok(nested.commands.some(command => command.startsWith('hdfs dfs')));
  for (const command of ['sh -c "$PAYLOAD"', 'eval "$PAYLOAD"', 'echo "rm old"', "cat <<'DATA'\nrm old\nDATA"]) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'ordinary', command);
  }
});

test('only called static function bodies and executable substitutions are protected', async () => {
  assert.equal((await classifyDangerousCommand('danger() { rm old; }; echo safe', context)).approval, 'ordinary');
  for (const command of ['danger() { rm old; }; danger', 'danger() { danger; rm old; }; danger', 'f() { hdfs dfs -ls /; }; sh -c "echo safe"; f', 'echo "$(rm old)"', 'cat <<DATA\n$(rm old)\nDATA', 'f() { sh -c "f() { f() { rm old; }; f; }; f"; }; f', 'f() { cd() { rm old; }; cd; }; f']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
  }
  assert.equal((await classifyDangerousCommand("cat <<'DATA'\n$(rm old)\nDATA", context)).approval, 'ordinary');
});

test('SQL clients classify effective input instead of shell data', async () => {
  for (const command of ["psql -X -c 'DELETE FROM records'", "beeline -e 'DROP TABLE records'", "hive -e 'INSERT INTO records VALUES (1)'", "spark-sql -e 'TRUNCATE TABLE records'", 'psql -X < "$INPUT"', "printf '%s' 'SELECT 1' | psql -X"]) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
  }
  for (const command of ["psql -X -c 'SELECT 1'", "psql -X <<'SQL'\nSELECT 1;\nSQL", "psql -X <<< 'SELECT 1;'", "echo psql -c 'DELETE FROM records'"]) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'ordinary', command);
  }
});

test('static cwd and local deletion operands survive nested policy classification', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'kit-shell-'));
  try {
    await writeFile(join(cwd, 'one.csv'), '1');
    await writeFile(join(cwd, 'two.csv'), '2');
    const analysis = await classifyDangerousCommand(`cd '${cwd}' && sh -c 'rm *.csv'`, context);
    assert.ok(analysis.paths.some(item => item.path === join(cwd, 'one.csv') && item.effect === 'write'));
    assert.ok(analysis.paths.some(item => item.path === join(cwd, 'two.csv') && item.effect === 'write'));
    assert.ok(analysis.commands.some(command => command.includes(cwd) && command.includes('rm *.csv')));
    const literal = await classifyDangerousCommand("rm '*.csv'", { cwd });
    assert.deepEqual(literal.paths, [{ path: join(cwd, '*.csv'), effect: 'write' }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('wrapper dynamic arguments do not hide known tools or invent executable payloads', async () => {
  for (const command of ['env TOKEN="$TOKEN" rm old', 'sudo -u "$USER" rm "$PATH"', "env -S 'rm -f old'", "env -S 'rm ${TARGET}'", "xargs -n 1 rm", 'git clean "$FLAGS"', 'rsync "$OPTIONS" a/ b/', 'DRY=-n; git clean "$DRY"', 'SQL="SELECT 1"; psql -X -c "$SQL"']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
  }
  for (const command of ['env -S "$PAYLOAD"', "env -S 'echo rm old'", 'command -v rm', 'sudo --list rm', 'env NAME=x "$COMMAND" old', 'CMD=rm; "$CMD" old']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'ordinary', command);
  }
});

test('deletion option data and end-of-options cannot masquerade as operation flags', async () => {
  for (const command of ["find . -name '-delete'", 'find . -exec echo -delete rm \\;', 'rsync -e --delete a/ b/', 'rsync -- --delete a/ b/']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'ordinary', command);
  }
  for (const command of ['git clean --for', 'git clean -f -- --dry-run', 'rsync --delete -e --dry-run a/ b/', 'find . -name rm -delete']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
  }
});

test('SQL file context follows static cwd, input redirects and env directory wrappers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'kit-sql-shell-'));
  try {
    await writeFile(join(cwd, 'read.sql'), 'SELECT 1;\n');
    await writeFile(join(cwd, 'write.sql'), 'DELETE FROM records;\n');
    for (const command of [`cd '${cwd}' && psql -X -f read.sql`, `env -C '${cwd}' psql -X -f read.sql`, `psql -X < '${cwd}/read.sql'`, `cd '${cwd}' && psql -X -f - < read.sql`]) {
      assert.equal((await classifyDangerousCommand(command, context)).approval, 'ordinary', command);
    }
    for (const command of [`cd '${cwd}' && psql -X -f write.sql`, `cd "$DIR" && psql -X -f read.sql`, `env -C "$DIR" psql -X -f read.sql`]) {
      assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
    }
    const analysis = await classifyDangerousCommand(`cd '${cwd}' && psql -X -f read.sql`, context);
    assert.ok(analysis.paths.some(item => item.path === join(cwd, 'read.sql') && item.effect === 'read'));
    const nested = await classifyDangerousCommand("psql -X -c '\\! rm protected.csv'", { cwd });
    assert.ok(nested.commands.some(command => command.includes('rm protected.csv')));
    assert.ok(nested.paths.some(item => item.path === join(cwd, 'protected.csv') && item.effect === 'write'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('static shell quoting and overridden rsync dry runs retain actual operation positions', async () => {
  for (const command of ["r'm' old", '$\'r\\x6d\' old', 'rsync --delete -n --no-dry-run a/ b/', 'rsync --remove-source-files a/ b/']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
  }
  assert.equal((await classifyDangerousCommand('rsync --delete --no-dry-run -n a/ b/', context)).approval, 'ordinary');
  assert.equal((await classifyDangerousCommand("echo $'rm old'", context)).approval, 'ordinary');
  const literal = await classifyDangerousCommand('rm \\$literal', context);
  assert.ok(literal.paths.some(item => item.path === '/tmp/$literal' && item.effect === 'write'));
});

test('function shadowing, redirects and cwd effects follow calls without executing declarations', async () => {
  assert.equal((await classifyDangerousCommand('rm() { echo safe; }; rm old', context)).approval, 'ordinary');
  assert.equal((await classifyDangerousCommand('hdfs() { hdfs; }; hdfs', context)).approval, 'ordinary');
  assert.equal((await classifyDangerousCommand('rm() { echo safe; }; command rm old', context)).approval, 'enhanced');
  const cwd = await mkdtemp(join(tmpdir(), 'kit-function-shell-'));
  try {
    await writeFile(join(cwd, 'read.sql'), 'SELECT 1;\n');
    const redirected = await classifyDangerousCommand(`query() { psql -X; } < '${cwd}/read.sql'; query`, context);
    assert.equal(redirected.approval, 'ordinary');
    const relocated = await classifyDangerousCommand(`go() { cd '${cwd}'; }; go; psql -X -f read.sql`, context);
    assert.equal(relocated.approval, 'ordinary');
    assert.equal((await classifyDangerousCommand(`cd '${cwd}' > /dev/null; psql -X -f read.sql`, context)).approval, 'ordinary');
    assert.equal((await classifyDangerousCommand(`if true; then cd '${cwd}'; fi; psql -X -f read.sql`, context)).approval, 'enhanced');
    assert.equal((await classifyDangerousCommand("if true; then psql -X -c 'SELECT 1'; fi", context)).approval, 'ordinary');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('wrapped executors expose their static inner policy operation', async () => {
  for (const command of ["env -S 'rm -f old'", 'sudo -u root rm old', 'find . -exec rm old \\;']) {
    const analysis = await classifyDangerousCommand(command, context);
    assert.ok(analysis.commands.some(inner => /^'?rm'? /.test(inner)), command);
  }
  assert.equal((await classifyDangerousCommand("find . -name '-exec' -name rm", context)).approval, 'ordinary');
});

test('opaque cwd-changing shell input stays ordinary until a known SQL file operation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'kit-uncertain-shell-'));
  try {
    await writeFile(join(cwd, 'read.sql'), 'SELECT 1;\n');
    for (const prefix of ['eval "$PAYLOAD"', 'source opaque.sh', 'pushd "$DIR"', '"$COMMAND"']) {
      assert.equal((await classifyDangerousCommand(prefix, { cwd })).approval, 'ordinary', prefix);
      assert.equal((await classifyDangerousCommand(`${prefix}; psql -X -f read.sql`, { cwd })).approval, 'enhanced', prefix);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('option values inside short clusters do not suppress actual deletion', async () => {
  for (const command of ['git clean -fe --dry-run', 'git clean -f --ex --dry-run', 'rsync --delete -ae --dry-run a/ b/', 'rsync --delete --rsync-pa --dry-run a/ b/']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
  }
  assert.equal((await classifyDangerousCommand('git clean -ne --force', context)).approval, 'ordinary');
});

test('git clean uses the final proven dry-run setting', async () => {
  for (const command of ['git clean -nf --no-dry-run', 'git clean -n "$OPTIONS" -f', 'git -c clean.requireForce=false clean -d']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
  }
  assert.equal((await classifyDangerousCommand('git clean -f --no-dry-run -n', context)).approval, 'ordinary');
});

test('executor option values, lock operands and job input cannot invent dangerous commands', async () => {
  for (const command of ['fd -e --exec rm', 'fd -- -x', 'flock /tmp/rm echo safe', "flock -c 'echo rm old' /tmp/lock", "watch 'echo rm old'", 'parallel echo ::: rm', 'command -v rm', 'sudo -v', 'sudo -u rm echo safe', 'f() { rm old; }; command f', 'f() { rm old; }; builtin f']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'ordinary', command);
  }
});

test('unknown option words cannot prove a later dry-run flag is really an option', async () => {
  for (const command of ['git clean "$OPTIONS" -n', 'rsync "$OPTIONS" -n --delete a/ b/']) {
    assert.equal((await classifyDangerousCommand(command, context)).approval, 'enhanced', command);
  }
  assert.equal((await classifyDangerousCommand('git clean -n -e "$EXCLUDE"', context)).approval, 'ordinary');
});
