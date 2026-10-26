import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { registry, run, packInfo } from './helpers/registry.mjs';
import { registerGigaChat } from '../dist/install.js';

test('packed npm installation and native Pi update keep GigaChat on the kit version', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'datalab-install-'));
  const server = await registry(root);
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.addGiga('0.6.5');
  await server.addGiga('0.6.6');
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
  assert.equal(JSON.parse(await readFile(gigaPath, 'utf8')).version, '0.6.5');
  const settingsAfterInstall = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.equal(settingsAfterInstall.defaultProvider, original.defaultProvider);
  assert.equal(settingsAfterInstall.defaultModel, original.defaultModel);
  assert.deepEqual(settingsAfterInstall.someUserSetting, original.someUserSetting);

  // Neither installation nor updates may follow a newer registry dist-tag.
  await run(process.execPath, [cli, 'update', '--extensions'], { cwd, env: { ...env, PI_OFFLINE: '' }, timeout: 100_000 });
  assert.equal(JSON.parse(await readFile(gigaPath, 'utf8')).version, '0.6.5');
  // Pi may restore its cached source after postinstall migrated the old pin.
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    ...settingsAfterInstall,
    packages: [...settingsAfterInstall.packages, { source: 'npm:@dev-sergeev/pi-gigachat@0.6.4', skills: [] }],
  }));

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir,
    sessionManager: SessionManager.inMemory(cwd) });
  try {
    assert.deepEqual(extensionsResult.errors, []);
    assert.ok(session.extensionRunner.getCommand('gigachat'));
    assert.ok(session.extensionRunner.getCommand('permission-system'));
    assert.equal(session.extensionRunner.getCommand('yolo'), undefined);
    await session.bindExtensions({});
    const configured = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    assert.ok(configured.packages.some(entry => entry?.source === 'npm:@dev-sergeev/pi-gigachat@0.6.5' && Array.isArray(entry.skills)));
    assert.equal(JSON.parse(await readFile(gigaPath, 'utf8')).version, '0.6.5', 'startup must not install a newly published version');
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    session.dispose();
  }
  await run(process.execPath, [cli, 'update', '--extensions'], { cwd, env: { ...env, PI_OFFLINE: '' }, timeout: 100_000 });
  assert.equal(JSON.parse(await readFile(gigaPath, 'utf8')).version, '0.6.5');
  assert.equal(JSON.parse(await readFile(join(agentDir, 'npm/node_modules/@dev-sergeev/datalab-kit/package.json'), 'utf8')).version, manifest.version);
});

test('former kit GigaChat sources migrate without losing filters or other user versions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'datalab-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'settings.json');
  for (const entry of [
    'npm:@dev-sergeev/pi-gigachat',
    { source: 'npm:@dev-sergeev/pi-gigachat', extensions: ['extension.js'], skills: [] },
    'npm:@dev-sergeev/pi-gigachat@0.6.4',
    { source: 'npm:@dev-sergeev/pi-gigachat@0.6.4', extensions: ['extension.js'], skills: [] },
  ]) {
    const original = { packages: ['npm:user-package', entry], defaultModel: 'user-model' };
    await writeFile(path, JSON.stringify(original));
    await registerGigaChat(root);
    const pinned = typeof entry === 'string'
      ? 'npm:@dev-sergeev/pi-gigachat@0.6.5'
      : { ...entry, source: 'npm:@dev-sergeev/pi-gigachat@0.6.5' };
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...original, packages: ['npm:user-package', pinned] });
    await registerGigaChat(root);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).packages, ['npm:user-package', pinned]);
  }
  const original = { packages: [{ source: 'npm:@dev-sergeev/pi-gigachat@0.6.3', extensions: [] }] };
  await writeFile(path, JSON.stringify(original));
  await registerGigaChat(root);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original);
});
