import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('short skill commands propagate authorization failure to the CLI exit status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'datalab-skill-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [resolve('.')] }));
  await writeFile(join(agentDir, 'auth.json'), '{}');
  const permissions = join(agentDir, 'extensions/pi-permission-system');
  await mkdir(permissions, { recursive: true });
  await writeFile(join(permissions, 'config.json'), JSON.stringify({ yoloMode: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(OPENAI_|CODEX_|GIGACHAT_)/.test(name) && name !== 'JPY_API_TOKEN'));
  const result = spawnSync(process.execPath,
    [resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--print', '--no-session',
      '--model', 'openai-codex/gpt-6-astra', '/init'],
    { cwd, env: { ...env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  await assert.rejects(access(join(cwd, 'AGENTS.md')));
});
