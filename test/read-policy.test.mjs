import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReadOnlyCommand, normalizeLocalReadCurl } from '../dist/read-policy.js';

test('shell operations are checked as a whole and unsafe curl options require approval', () => {
  for (const command of ['cat a | grep x', "find /tmp -name '*.ts'", 'ls /tmp && cat /etc/hosts']) {
    assert.equal(isReadOnlyCommand(command), true, command);
  }
  for (const command of ['cat a > b', 'find . -exec rm {} \\;', 'find . *', 'find . ?', 'find . [a-z]*', 'fd -x rm', 'rg --pre sh x', 'sort -o file file', 'sort --compress-program=sh file', 'sort --compress=sh file', 'cat $(rm a)',
    'curl -L http://localhost', 'curl -o file http://localhost', 'curl --proxy https://example.com http://localhost',
    'curl -d data http://localhost', 'curl --config file http://localhost', 'curl http://localhost https://example.com']) {
    assert.equal(isReadOnlyCommand(command), false, command);
    assert.equal(normalizeLocalReadCurl(command), undefined, command);
  }
  const normalized = normalizeLocalReadCurl('curl http://localhost:8080/data');
  assert.ok(normalized.startsWith("'curl' '-q' '--noproxy' '*'"));
  assert.equal(isReadOnlyCommand(normalized), true);
  assert.equal(normalizeLocalReadCurl('curl http://localhost && cat file'), undefined);
});
