import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySqlClient } from '../dist/enhanced-sql.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const context = { cwd: process.cwd() };

test('a psql mutation requires enhanced approval at the public classifier', () => {
  const analysis = classifySqlClient(['psql', '-X', '-c', 'UPDATE accounts SET active = false;'], context);
  assert.equal(analysis.approval, 'enhanced');
});

test('complete read-only scripts ignore string and comment keywords but reject unknown effects', () => {
  for (const sql of [
    'SELECT 1;',
    "SELECT 'DROP TABLE x; DELETE FROM x;' AS message; -- UPDATE x\nSELECT 2;",
    'SELECT $$DELETE; DROP$$ AS message;',
    '/* outer /* UPDATE x */ DROP */ SELECT "delete" FROM accounts;',
    'WITH totals AS (SELECT count(*) AS n FROM accounts) SELECT n FROM totals;',
    'SHOW server_version; VALUES (1), (2);',
  ]) {
    assert.equal(classifySqlClient(['psql', '-X', '-c', sql], context).approval, 'ordinary', sql);
  }
  for (const sql of [
    'SELECT 1; INSERT INTO accounts VALUES (1);',
    'WITH removed AS (DELETE FROM accounts RETURNING *) SELECT * FROM removed;',
    'SELECT unknown_function();',
    'SELECT "unknown_function"();',
    'SELECT app.count(*) FROM accounts;',
    'CALL maintain();',
    'EXECUTE prepared_statement;',
    'SELECT * INTO snapshot FROM accounts;',
    'SELECT * FROM accounts FOR UPDATE;',
    "SELECT 'unclosed",
  ]) {
    assert.equal(classifySqlClient(['psql', '-X', '-c', sql], context).approval, 'enhanced', sql);
  }
});

test('all actual SQL inputs and startup controls are classified, not echo options', () => {
  assert.equal(classifySqlClient(['psql', '-c', 'SELECT 1'], context).approval, 'enhanced');
  assert.equal(classifySqlClient(['/usr/bin/psql', '-XAt', '-cSELECT 1', '-e'], context).approval, 'ordinary');
  assert.equal(classifySqlClient(['psql', '--no-psqlrc', '--command=SELECT 1'], context).approval, 'ordinary');
  assert.equal(classifySqlClient(['psql', '-X', '-c', 'SELECT 1', '-c', 'ALTER TABLE t ADD COLUMN x int'], context).approval, 'enhanced');
  assert.equal(classifySqlClient(['hive', '-e', 'SELECT 1'], context).approval, 'enhanced');
  assert.equal(classifySqlClient(['spark-sql', '-e', 'SELECT 1'], context).approval, 'enhanced');
  assert.equal(classifySqlClient(['psql', '-X', '--unknown-setting', '-c', 'SELECT 1'], context).approval, 'enhanced');
  assert.equal(classifySqlClient(['psql', '-X', '-v', 'x=DELETE', '-c', 'SELECT :x'], context).approval, 'enhanced');
  assert.equal(classifySqlClient(['mysql', '-e', 'DELETE FROM t'], context).approval, 'ordinary');
});

test('local SQL and explicit initialization files are read, and unknown files are protected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'datalab-sql-'));
  try {
    writeFileSync(join(directory, 'read.sql'), 'SELECT 1;');
    writeFileSync(join(directory, 'write.sql'), 'GRANT SELECT ON t TO public;');
    writeFileSync(join(directory, 'init.sql'), '-- empty initialization');
    const local = { cwd: directory };
    assert.equal(classifySqlClient(['psql', '-X', '--file=read.sql'], local).approval, 'ordinary');
    const mutation = classifySqlClient(['psql', '-X', '-f', 'write.sql'], local);
    assert.equal(mutation.approval, 'enhanced');
    assert.ok(mutation.paths.some(path => path.path === join(directory, 'write.sql') && path.effect === 'read'));
    for (const client of ['hive', 'spark-sql']) {
      assert.equal(classifySqlClient([client, '-i', 'init.sql', '-f', 'read.sql'], local).approval, 'ordinary');
      assert.equal(classifySqlClient([client, '-i', 'write.sql', '-e', 'SELECT 1'], local).approval, 'enhanced');
    }
    for (const path of ['missing.sql', 'hdfs://server/query.sql', '${query}.sql']) {
      assert.equal(classifySqlClient(['psql', '-X', '-f', path], local).approval, 'enhanced', path);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stdin is used only when the client actually reads it', () => {
  const mutationStdin = { ...context, stdin: { kind: 'text', value: 'DELETE FROM accounts;' } };
  const readStdin = { ...context, stdin: { kind: 'text', value: 'SELECT 1;' } };
  assert.equal(classifySqlClient(['psql', '-X'], mutationStdin).approval, 'enhanced');
  assert.equal(classifySqlClient(['psql', '-X', '-f', '-'], readStdin).approval, 'ordinary');
  assert.equal(classifySqlClient(['psql', '-X', '-c', 'SELECT 1'], mutationStdin).approval, 'ordinary');
  assert.equal(classifySqlClient(['psql', '-X'], context).approval, 'enhanced');
});

test('recursive includes preserve paths and protect cycles, escapes, and hidden commands', () => {
  const directory = mkdtempSync(join(tmpdir(), 'datalab-sql-'));
  try {
    writeFileSync(join(directory, 'read.sql'), 'SELECT 1;');
    writeFileSync(join(directory, 'include.sql'), '\\ir read.sql\nSELECT 2;');
    writeFileSync(join(directory, 'cycle.sql'), '\\ir cycle.sql\n');
    writeFileSync(join(directory, 'hidden.sql'), '\\! rm -f /tmp/private-data\nSELECT 1;');
    const local = { cwd: directory };
    const read = classifySqlClient(['psql', '-X', '-f', 'include.sql'], local);
    assert.equal(read.approval, 'ordinary');
    assert.ok(read.paths.some(path => path.path === join(directory, 'read.sql')));
    assert.equal(classifySqlClient(['psql', '-X', '-f', 'cycle.sql'], local).approval, 'enhanced');
    const hidden = classifySqlClient(['psql', '-X', '-f', 'hidden.sql'], local);
    assert.equal(hidden.approval, 'enhanced');
    assert.ok(hidden.commands.includes('rm -f /tmp/private-data'));
    for (const sql of ["SELECT 'DROP TABLE t' \\gexec", "\\copy accounts TO PROGRAM 'rm -f /tmp/data'", '\\echo `rm -f /tmp/data`']) {
      const analysis = classifySqlClient(['psql', '-X', '-c', sql], local);
      assert.equal(analysis.approval, 'enhanced', sql);
      if (sql !== "SELECT 'DROP TABLE t' \\gexec") assert.ok(analysis.commands.includes('rm -f /tmp/data'), sql);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Beeline connection/init preferences and all executable escape intents are protected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'datalab-sql-'));
  try {
    writeFileSync(join(directory, 'init.sql'), 'SELECT 1;');
    writeFileSync(join(directory, 'write.sql'), "INSERT OVERWRITE DIRECTORY '/tmp/result' SELECT 1;");
    const local = { cwd: directory };
    const url = 'jdbc:hive2://localhost:10000/default';
    assert.equal(classifySqlClient(['beeline', '-u', url, '-e', 'SELECT 1'], local).approval, 'ordinary');
    assert.equal(classifySqlClient(['beeline', '-e', 'SELECT 1'], local).approval, 'enhanced');
    assert.ok(classifySqlClient(['beeline', '-u', `${url};initFile=write.sql`, '-e', 'SELECT 1'], local).paths.some(path => path.path === join(directory, 'write.sql')));
    assert.equal(classifySqlClient(['beeline', '-u', url, '--property-file', 'unknown.properties', '-e', 'SELECT 1'], local).approval, 'enhanced');
    assert.equal(classifySqlClient(['beeline', '-u', url, '-i', 'write.sql', '-e', 'SELECT 1'], local).approval, 'enhanced');
    const dfs = classifySqlClient(['spark-sql', '-i', 'init.sql', '-e', 'dfs -rm -r /warehouse/private;'], local);
    assert.equal(dfs.approval, 'enhanced');
    assert.ok(dfs.commands.includes('hdfs dfs -rm -r /warehouse/private'));
    const shell = classifySqlClient(['hive', '-i', 'init.sql', '-e', '!sh rm -f /tmp/private;'], local);
    assert.equal(shell.approval, 'enhanced');
    assert.ok(shell.commands.includes('rm -f /tmp/private'));
    const source = classifySqlClient(['spark-sql', '-i', 'init.sql', '-e', 'source write.sql;'], local);
    assert.equal(source.approval, 'enhanced');
    assert.ok(source.paths.some(path => path.path === '/tmp/result' && path.effect === 'write'));
    for (const client of ['hive', 'spark-sql']) {
      const file = classifySqlClient([client, '-i', 'init.sql', '-f', '-'], { ...local, stdin: { kind: 'text', value: 'SELECT 1' } });
      assert.equal(file.approval, 'enhanced');
      assert.ok(file.paths.some(path => path.path === join(directory, '-')));
    }
    const output = classifySqlClient(['psql', '-X', '-o', '/tmp/private-output', '-c', 'SELECT 1'], local);
    assert.equal(output.approval, 'enhanced');
    assert.ok(output.paths.some(path => path.path === '/tmp/private-output' && path.effect === 'write'));
    const copy = classifySqlClient(['psql', '-X', '-c', "\\copy t TO '/tmp/private-copy'"], local);
    assert.ok(copy.paths.some(path => path.path === '/tmp/private-copy' && path.effect === 'write'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mutating and unknown SQL families never receive the read-only exemption', () => {
  for (const sql of [
    'CREATE TABLE t (x int);', 'DROP TABLE t;', 'TRUNCATE t;', 'ALTER TABLE t ADD COLUMN x int;',
    'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = 1;',
    'GRANT SELECT ON t TO public;', 'REVOKE SELECT ON t FROM public;', 'VACUUM t;', 'REINDEX TABLE t;',
    "COPY t TO '/tmp/export';", "LOAD DATA INPATH '/tmp/data' INTO TABLE t;",
    'CREATE FUNCTION f() RETURNS void AS $$BEGIN DELETE FROM t; END$$ LANGUAGE plpgsql;',
    'SELECT nextval(\'sequence\');', "SELECT pg_read_file('/etc/passwd');",
    'EXPLAIN ANALYZE DELETE FROM t;', 'WITH x AS (SELECT 1) EXECUTE job;',
    "SELECT E'escaped\\' DROP TABLE t';",
  ]) {
    assert.equal(classifySqlClient(['psql', '-X', '-c', sql], context).approval, 'enhanced', sql);
  }
});

test('includes and SQL inputs have finite recursion and size limits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'datalab-sql-'));
  try {
    for (let index = 0; index < 12; index++) {
      writeFileSync(join(directory, `${index}.sql`), index === 11 ? 'SELECT 1;' : `\\ir ${index + 1}.sql\n`);
    }
    writeFileSync(join(directory, 'large.sql'), '--'.padEnd(1024 * 1024 + 1, 'x'));
    const local = { cwd: directory };
    assert.equal(classifySqlClient(['psql', '-X', '-f', '0.sql'], local).approval, 'enhanced');
    assert.equal(classifySqlClient(['psql', '-X', '-f', 'large.sql'], local).approval, 'enhanced');
    assert.equal(classifySqlClient(['psql', '-X', '-c', 'SELECT 1'], { ...local, dynamic: true }).approval, 'enhanced');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CTE column declarations remain reads, while function calls in their final query do not', () => {
  assert.equal(classifySqlClient(['psql', '-X', '-c', 'WITH totals(n) AS (SELECT count(*) FROM t) SELECT n FROM totals;'], context).approval, 'ordinary');
  assert.equal(classifySqlClient(['psql', '-X', '-c', 'WITH totals(n) AS (SELECT count(*) FROM t) SELECT n, dangerous() AS x FROM totals;'], context).approval, 'enhanced');
});

test('known startup files expose hidden commands and explicit init executes before queries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'datalab-sql-'));
  try {
    writeFileSync(join(directory, 'rc.sql'), '\\! rm -f /tmp/startup-data\n');
    writeFileSync(join(directory, 'init.sql'), "source 'write.sql';");
    writeFileSync(join(directory, 'write.sql'), "INSERT OVERWRITE DIRECTORY '/tmp/init-result' SELECT 1;");
    const rc = classifySqlClient(['psql', '-c', 'SELECT 1'], { cwd: directory, env: { PSQLRC: 'rc.sql' } });
    assert.equal(rc.approval, 'enhanced');
    assert.ok(rc.commands.includes('rm -f /tmp/startup-data'));
    assert.equal(classifySqlClient(['psql', '-X', '-c', 'SELECT 1'], { cwd: directory, env: { PSQLRC: 'rc.sql' } }).approval, 'ordinary');
    const init = classifySqlClient(['spark-sql', '-e', 'SELECT 1', '-i', 'init.sql'], { cwd: directory });
    assert.ok(init.paths.some(path => path.path === '/tmp/init-result' && path.effect === 'write'));
    assert.equal(classifySqlClient(['psql', '-X', '--toString', '-c', 'SELECT 1'], context).approval, 'enhanced');
    assert.deepEqual(classifySqlClient(['psql', '-X'], { cwd: directory, stdin: { kind: 'file', value: 'write.sql' } }).paths[0], { path: join(directory, 'write.sql'), effect: 'read' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI line splitting cannot hide executable SQL inside a multiline quoted/comment region', () => {
  const directory = mkdtempSync(join(tmpdir(), 'datalab-sql-'));
  try {
    writeFileSync(join(directory, 'init.sql'), '');
    const sql = '/* comment;\nDELETE FROM accounts;\n*/ SELECT 1;';
    assert.equal(classifySqlClient(['psql', '-X', '-c', sql], context).approval, 'ordinary');
    assert.equal(classifySqlClient(['spark-sql', '-i', 'init.sql', '-e', sql], { cwd: directory }).approval, 'enhanced');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
