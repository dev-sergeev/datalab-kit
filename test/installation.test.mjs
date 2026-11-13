import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { registry, run } from './helpers/registry.mjs';

const components = [
  '@dev-sergeev/pi-gigachat',
  '@juicesharp/rpiv-ask-user-question',
  'pi-powerline-footer',
  '@gotgenes/pi-permission-system',
  '@narumitw/pi-plan-mode',
  '@gotgenes/pi-subagents',
  '@capdiem/pi-todo',
  'pi-rewind',
  '@dev-sergeev/pi-recap',
  '@pi-plugins/elapsed',
  'pi-toggle-skills',
  '@zigai/pi-mention-skill',
];
const installer = resolve('scripts/install.mjs');
const sources = components.map(name => `npm:${name}`);
const settings = async dir => JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'datalab-install-'));
  const server = await registry(root);
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  await mkdir(agentDir);
  await mkdir(cwd);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '',
    PATH: `${resolve('node_modules/.bin')}${delimiter}${process.env.PATH}`,
    npm_config_registry: server.origin, npm_config_cache: join(root, 'npm-cache'),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_min_release_age: '0',
    npm_config_fetch_retries: '0' };
  const options = { cwd, env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 };
  return { root, server, agentDir, cwd, env, options,
    install: (...args) => run(process.execPath, [installer, ...args], options),
    pi: (...args) => run('pi', args, options) };
}

test('one-time CLI installs twelve independent unversioned Pi packages', { timeout: 300_000 }, async t => {
  const f = await fixture(t);
  for (const name of components) await f.server.addComponent(name);
  const original = { defaultProvider: 'user-provider', defaultModel: 'user-model', someUserSetting: { untouched: true } };
  await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify(original));
  await f.install();
  assert.deepEqual(await settings(f.agentDir), { ...original, packages: sources });
  for (const name of components) {
    const manifest = JSON.parse(await readFile(join(f.agentDir, 'npm/node_modules', name, 'package.json'), 'utf8'));
    assert.equal(manifest.version, '1.0.0');
  }
  await f.server.addComponent('pi-rewind', '1.1.0');
  await f.pi('update', 'npm:pi-rewind');
  const rewindPath = join(f.agentDir, 'npm/node_modules/pi-rewind/package.json');
  assert.equal(JSON.parse(await readFile(rewindPath, 'utf8')).version, '1.1.0');
  await f.pi('uninstall', 'npm:pi-toggle-skills');
  await f.pi('install', 'npm:pi-rewind@1.0.0');
  const chosen = await settings(f.agentDir);
  await f.install();
  assert.deepEqual(await settings(f.agentDir), chosen, 'completed bootstrap must not restore removals or replace a user pin');
  assert.equal(JSON.parse(await readFile(rewindPath, 'utf8')).version, '1.0.0');
  await f.server.close();
  await f.install();
  assert.deepEqual(await settings(f.agentDir), chosen, 'completed invocation must not need the registry');
});

test('legacy migration preserves pinned filtered sources, unrelated settings and user skills', { timeout: 300_000 }, async t => {
  const f = await fixture(t);
  for (const name of components) await f.server.addComponent(name);
  await f.server.addComponent('@dev-sergeev/pi-gigachat', '0.6.4');
  await f.server.addComponent('@dev-sergeev/datalab-kit', '0.1.8');
  await f.pi('install', 'npm:@dev-sergeev/datalab-kit@0.1.8');
  await f.pi('install', 'npm:@dev-sergeev/pi-gigachat@0.6.4');
  const giga = { source: 'npm:@dev-sergeev/pi-gigachat@0.6.4', extensions: [], skills: [], autoload: false };
  const copiedSkill = join(f.agentDir, 'skills/init/SKILL.md');
  await mkdir(join(f.agentDir, 'skills/init'), { recursive: true });
  await writeFile(copiedSkill, '# User-owned skill\n');
  const original = { defaultModel: 'user-model', someUserSetting: { untouched: true },
    packages: [{ source: 'npm:@dev-sergeev/datalab-kit@0.1.8', skills: [] }, giga] };
  await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify(original));
  await f.install();
  assert.deepEqual(await settings(f.agentDir), { ...original, packages: [giga, ...sources.slice(1)] });
  assert.equal(JSON.parse(await readFile(join(f.agentDir, 'npm/node_modules/@dev-sergeev/pi-gigachat/package.json'), 'utf8')).version, '0.6.4');
  await assert.rejects(readFile(join(f.agentDir, 'npm/node_modules/@dev-sergeev/datalab-kit/package.json'), 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(copiedSkill, 'utf8'), '# User-owned skill\n');
  await f.pi('install', 'npm:@dev-sergeev/datalab-kit@0.1.8');
  await f.pi('uninstall', 'npm:@dev-sergeev/datalab-kit@0.1.8');
  const afterReinstall = await settings(f.agentDir);
  await f.install();
  assert.deepEqual(await settings(f.agentDir), afterReinstall, 'marker must survive uninstalling and reinstalling the kit');
});

test('partial failure resumes the original plan without restoring a completed then removed component', { timeout: 300_000 }, async t => {
  const f = await fixture(t);
  for (const name of components.slice(0, 3)) await f.server.addComponent(name);
  await f.server.addComponent('@dev-sergeev/datalab-kit', '0.1.8');
  await f.pi('install', 'npm:@dev-sergeev/datalab-kit@0.1.8');
  await assert.rejects(f.install(), /failed/);
  assert.deepEqual((await settings(f.agentDir)).packages, ['npm:@dev-sergeev/datalab-kit@0.1.8', ...sources.slice(0, 3)]);
  await f.pi('uninstall', sources[0]);
  for (const name of components.slice(3)) await f.server.addComponent(name);
  await f.install();
  assert.deepEqual((await settings(f.agentDir)).packages, sources.slice(1));
  await f.install();
  assert.deepEqual((await settings(f.agentDir)).packages, sources.slice(1));
});

test('global and local bootstrap plans are isolated and local installation respects Pi trust', { timeout: 600_000 }, async t => {
  const f = await fixture(t);
  for (const name of components) await f.server.addComponent(name);
  await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never' }));
  await assert.rejects(f.install('--local'), /not trusted/);
  assert.deepEqual(await settings(f.agentDir), { defaultProjectTrust: 'never' });
  await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }));
  await f.install('--local');
  const localDir = join(f.cwd, '.pi');
  assert.deepEqual((await settings(localDir)).packages, sources);
  assert.deepEqual(await settings(f.agentDir), { defaultProjectTrust: 'always' });
  await f.pi('uninstall', sources[0], '--local');
  await f.install();
  assert.deepEqual((await settings(f.agentDir)).packages, sources);
  assert.deepEqual((await settings(localDir)).packages, sources.slice(1));
  await f.pi('uninstall', sources[1]);
  await f.install('--local');
  await f.install();
  assert.deepEqual((await settings(localDir)).packages, sources.slice(1));
  assert.deepEqual((await settings(f.agentDir)).packages, sources.filter(source => source !== sources[1]));
});

test('CLI rejects invalid settings, markers and arguments before installing packages', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  assert.match((await f.install('--help')).stdout, /Usage: datalab-kit/);
  await assert.rejects(f.install('--unknown'), /Usage: datalab-kit/);
  const path = join(f.agentDir, 'settings.json');
  for (const invalid of ['{broken', '[]', '{"packages":{}}', '{"packages":[{"source":7}]}', '{"packages":[{"source":"npm:example","skills":[7]}]}']) {
    await writeFile(path, invalid);
    await assert.rejects(f.install());
    assert.equal(await readFile(path, 'utf8'), invalid);
  }
  await writeFile(path, '{}');
  const marker = join(f.agentDir, '.datalab-kit-install.json');
  for (const invalid of ['{broken', '{}', '{"version":1,"pending":["npm:unexpected"],"remove":[],"complete":false}',
    '{"version":1,"pending":[],"remove":["npm:user-package"],"complete":false}',
    '{"version":1,"pending":["npm:pi-rewind"],"remove":[],"complete":false,"normalize":"npm:unexpected"}',
    '{"version":1,"pending":["npm:pi-rewind","npm:pi-toggle-skills"],"remove":[],"complete":false,"normalize":"npm:pi-toggle-skills"}']) {
    await writeFile(marker, invalid);
    await assert.rejects(f.install());
    assert.deepEqual(await settings(f.agentDir), {});
    assert.equal(await readFile(marker, 'utf8'), invalid);
  }
});

test('local component sources remain unchanged and uninstalling a local legacy kit leaves its checkout intact', { timeout: 300_000 }, async t => {
  const f = await fixture(t);
  for (const name of components) await f.server.addComponent(name);
  const checkout = join(f.root, 'legacy-checkout');
  const footer = join(f.root, 'custom-footer');
  await mkdir(checkout);
  await mkdir(footer);
  const legacyManifest = JSON.stringify({ name: '@dev-sergeev/datalab-kit', version: '0.1.8', pi: { extensions: [] } });
  await writeFile(join(checkout, 'package.json'), legacyManifest);
  await writeFile(join(footer, 'package.json'), JSON.stringify({ name: 'pi-powerline-footer', version: '9.0.0', pi: { extensions: [] } }));
  await f.pi('install', checkout);
  await f.pi('install', footer);
  const configured = await settings(f.agentDir);
  const footerEntry = configured.packages.find(entry => !String(typeof entry === 'string' ? entry : entry.source).includes('legacy-checkout'));
  await f.install();
  assert.deepEqual((await settings(f.agentDir)).packages, [footerEntry, ...sources.filter(source => source !== 'npm:pi-powerline-footer')]);
  assert.equal(await readFile(join(checkout, 'package.json'), 'utf8'), legacyManifest);
  assert.equal(JSON.parse(await readFile(join(footer, 'package.json'), 'utf8')).version, '9.0.0');
});

test('the one-time CLI requires an existing Pi and a completed plan never adds components', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(run(process.execPath, [installer], { ...f.options, env: { ...f.env, PATH: '' } }), /Pi must already be installed/);
  await assert.rejects(readFile(join(f.agentDir, '.datalab-kit-install.json')), { code: 'ENOENT' });
  await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify({ userSetting: true }));
  await writeFile(join(f.agentDir, '.datalab-kit-install.json'), JSON.stringify({ version: 1, pending: [], remove: [], complete: true }));
  await f.install();
  assert.deepEqual(await settings(f.agentDir), { userSetting: true }, 'later kit compositions must not expand a completed plan');
});

test('initial bootstrap installs latest when an unregistered older npm dependency remains', { timeout: 300_000 }, async t => {
  const f = await fixture(t);
  for (const name of components) await f.server.addComponent(name);
  await f.pi('install', 'npm:pi-rewind@1.0.0');
  await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify({ packages: [] }));
  await f.server.addComponent('pi-rewind', '2.0.0');
  await f.install();
  assert.deepEqual((await settings(f.agentDir)).packages, sources);
  assert.equal(JSON.parse(await readFile(join(f.agentDir, 'npm/node_modules/pi-rewind/package.json'), 'utf8')).version, '2.0.0');
});

test('GitHub shorthand sources preserve an existing filtered component and migrate the former kit', { timeout: 300_000 }, async t => {
  const f = await fixture(t);
  for (const name of components.slice(1)) await f.server.addComponent(name);
  const gigaDir = join(f.agentDir, 'git/github.com/dev-sergeev/pi-gigachat');
  const kitDir = join(f.agentDir, 'git/github.com/dev-sergeev/datalab-kit');
  await mkdir(gigaDir, { recursive: true });
  await mkdir(kitDir, { recursive: true });
  await writeFile(join(gigaDir, 'package.json'), JSON.stringify({ name: '@dev-sergeev/pi-gigachat', version: '0.6.4', pi: { extensions: [] } }));
  await writeFile(join(kitDir, 'package.json'), JSON.stringify({ name: '@dev-sergeev/datalab-kit', version: '0.1.8', pi: { extensions: [] } }));
  const giga = { source: 'git:dev-sergeev/pi-gigachat', extensions: [], skills: [], autoload: false };
  await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify({ packages: [giga, 'git:dev-sergeev/datalab-kit'], userSetting: true }));
  await f.install();
  assert.deepEqual(await settings(f.agentDir), { packages: [giga, ...sources.slice(1)], userSetting: true });
  assert.equal(JSON.parse(await readFile(join(gigaDir, 'package.json'), 'utf8')).version, '0.6.4');
  await assert.rejects(readFile(join(kitDir, 'package.json')), { code: 'ENOENT' });
});

test('resuming a temporary latest installation finishes its unversioned source without changing user pins', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  await f.server.addComponent('@dev-sergeev/pi-gigachat');
  await f.server.addComponent('pi-rewind', '2.0.0');
  await f.pi('install', 'npm:@dev-sergeev/pi-gigachat@1.0.0');
  await f.pi('install', 'npm:pi-rewind@latest');
  const giga = { source: 'npm:@dev-sergeev/pi-gigachat@1.0.0', extensions: [], skills: [] };
  await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify({ packages: [giga, 'npm:pi-rewind@latest'], userSetting: true }));
  await writeFile(join(f.agentDir, '.datalab-kit-install.json'), JSON.stringify({
    version: 1, pending: ['npm:pi-rewind'], remove: [], complete: false, normalize: 'npm:pi-rewind',
  }));
  await f.install();
  assert.deepEqual(await settings(f.agentDir), { packages: [giga, 'npm:pi-rewind'], userSetting: true });
  assert.equal(JSON.parse(await readFile(join(f.agentDir, 'npm/node_modules/pi-rewind/package.json'), 'utf8')).version, '2.0.0');
  assert.equal(JSON.parse(await readFile(join(f.agentDir, 'npm/node_modules/@dev-sergeev/pi-gigachat/package.json'), 'utf8')).version, '1.0.0');
});

test('resuming a failed plan preserves a user-installed latest source and its filters', { timeout: 300_000 }, async t => {
  const f = await fixture(t);
  for (const name of components.slice(0, 7)) await f.server.addComponent(name);
  await assert.rejects(f.install(), /failed/);
  await f.server.addComponent('pi-rewind', '2.0.0');
  await f.pi('install', 'npm:pi-rewind@latest');
  const before = await settings(f.agentDir);
  const rewind = { source: 'npm:pi-rewind@latest', extensions: [], skills: [], autoload: false };
  await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify({
    ...before, packages: before.packages.map(entry => entry === 'npm:pi-rewind@latest' ? rewind : entry),
  }));
  for (const name of components.slice(8)) await f.server.addComponent(name);
  await f.install();
  assert.deepEqual((await settings(f.agentDir)).packages, [...sources.slice(0, 7), rewind, ...sources.slice(8)]);
  assert.equal(JSON.parse(await readFile(join(f.agentDir, 'npm/node_modules/pi-rewind/package.json'), 'utf8')).version, '2.0.0');
});
