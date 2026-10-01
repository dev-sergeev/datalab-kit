import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { registry, run, packInfo } from './helpers/registry.mjs';

test('packed npm installation loads all components and native Pi update refreshes GigaChat independently', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'datalab-install-'));
  const server = await registry(root);
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.addGiga('1.0.0');
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { maxBuffer: 16 * 1024 * 1024 });
  const packed = packInfo(stdout);
  assert.equal(packed.files.some(file => file.path.startsWith('node_modules/@earendil-works/')), false, 'must not bundle host APIs');
  assert.equal(packed.files.some(file => /^dist\/(confirmation|yolo)\./.test(file.path)), false, 'must not ship removed dialog or YOLO modules');
  await server.add(manifest, join(root, packed.filename));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  await mkdir(agentDir);
  await mkdir(cwd);
  const original = { defaultProvider: 'user-provider', defaultModel: 'user-model', someUserSetting: { untouched: true } };
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(original));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, npm_config_registry: server.origin,
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_min_release_age: '0' };
  const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  await run(process.execPath, [cli, 'install', 'npm:@dev-sergeev/datalab-kit'], { cwd, env, timeout: 100_000 });
  const gigaPath = join(agentDir, 'npm/node_modules/@dev-sergeev/pi-gigachat/package.json');
  assert.equal(JSON.parse(await readFile(gigaPath, 'utf8')).version, '1.0.0');
  const settingsAfterInstall = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.equal(settingsAfterInstall.defaultProvider, original.defaultProvider);
  assert.equal(settingsAfterInstall.defaultModel, original.defaultModel);
  assert.deepEqual(settingsAfterInstall.someUserSetting, original.someUserSetting);

  await server.addGiga('1.0.1');
  // Document the remaining host compatibility gap without concealing it behind
  // a first-start-only test: Pi lost postinstall's standalone source declaration.
  await run(process.execPath, [cli, 'update', '--extensions'], { cwd, env: { ...env, PI_OFFLINE: '' }, timeout: 100_000 });
  assert.equal(JSON.parse(await readFile(gigaPath, 'utf8')).version, '1.0.0', 'known Pi 0.85.1 gap before first activation');

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir,
    sessionManager: SessionManager.inMemory(cwd) });
  try {
    assert.deepEqual(extensionsResult.errors, []);
    assert.equal(extensionsResult.extensions.length, 8);
    assert.ok(session.extensionRunner.getCommand('fixture-giga'));
    assert.ok(session.extensionRunner.getCommand('permission-system'));
    assert.equal(session.extensionRunner.getCommand('yolo'), undefined);
    await session.bindExtensions({});
    const configured = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    assert.ok(configured.packages.includes('npm:@dev-sergeev/pi-gigachat'));
    assert.equal(JSON.parse(await readFile(gigaPath, 'utf8')).version, '1.0.0', 'startup must not install a newly published version');
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    session.dispose();
  }
  await run(process.execPath, [cli, 'update', '--extensions'], { cwd, env: { ...env, PI_OFFLINE: '' }, timeout: 100_000 });
  assert.equal(JSON.parse(await readFile(gigaPath, 'utf8')).version, '1.0.1');
  assert.equal(JSON.parse(await readFile(join(agentDir, 'npm/node_modules/@dev-sergeev/datalab-kit/package.json'), 'utf8')).version, manifest.version);
});
