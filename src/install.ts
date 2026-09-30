import { mkdir, readFile, rename, rm, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const gigaChatSource = 'npm:@dev-sergeev/pi-gigachat';
const execFileAsync = promisify(execFile);

export function managedAgentDir(packageRoot: string): string | undefined {
  const npmRoot = resolve(packageRoot, '../../..');
  return basename(npmRoot) === 'npm' && basename(resolve(packageRoot, '../..')) === 'node_modules'
    ? dirname(npmRoot) : undefined;
}

export function isGigaChatSource(entry: unknown): boolean {
  const source = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'source' in entry ? entry.source : undefined;
  return typeof source === 'string' && (source === gigaChatSource || source.startsWith(`${gigaChatSource}@`));
}

async function readSettings(agentDir: string): Promise<Record<string, unknown>> {
  let content: string;
  try { content = await readFile(join(agentDir, 'settings.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  const settings: unknown = JSON.parse(content.replace(/^\uFEFF/, ''));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Pi settings must be a JSON object');
  return settings as Record<string, unknown>;
}

export async function hasConfiguredGigaChat(agentDir: string): Promise<boolean> {
  const settings = await readSettings(agentDir);
  return Array.isArray(settings.packages) && settings.packages.some(isGigaChatSource);
}

/** Preserve every user field and package filter; only add a missing source. */
export async function registerGigaChat(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const lock = join(agentDir, 'settings.json.lock');
  await mkdir(lock);
  const temp = join(agentDir, `.datalab-settings-${randomUUID()}.tmp`);
  try {
    const settings = await readSettings(agentDir);
    if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error('Pi packages must be an array');
    const packages = (settings.packages ?? []) as unknown[];
    if (packages.some(isGigaChatSource)) return;
    settings.packages = [...packages, gigaChatSource];
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, join(agentDir, 'settings.json'));
  } finally {
    await rm(temp, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

/** Only run inside an explicit npm installation; Pi startup never calls this. */
export async function finishInstallation(packageRoot: string): Promise<void> {
  const agentDir = managedAgentDir(packageRoot);
  if (!agentDir) return; // An ordinary development npm install is not a Pi install.
  const settings = await readSettings(agentDir);
  const existing = Array.isArray(settings.packages) ? settings.packages.find(isGigaChatSource) : undefined;
  const source = typeof existing === 'string' ? existing : existing?.source;
  // An explicitly selected user version remains authoritative.
  if (typeof source === 'string' && source !== gigaChatSource) return;
  await refreshGigaChat(agentDir);
  await registerGigaChat(agentDir);
}

export function gigaChatExtensionPath(packageRoot: string): string {
  const agentDir = managedAgentDir(packageRoot);
  if (agentDir) {
    const managed = join(agentDir, 'npm/node_modules/@dev-sergeev/pi-gigachat/extension.js');
    if (existsSync(managed)) return managed;
  }
  const require = createRequire(join(packageRoot, 'package.json'));
  return join(dirname(require.resolve('@dev-sergeev/pi-gigachat/package.json')), 'extension.js');
}

async function npm(args: string[]): Promise<string> {
  const command = process.env.npm_execpath;
  const result = command
    ? await execFileAsync(process.execPath, [command, ...args], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    : await execFileAsync('npm', args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

async function refreshGigaChat(agentDir: string): Promise<void> {
  const metadata: unknown = JSON.parse(await npm(['view', '@dev-sergeev/pi-gigachat@latest', 'version', '--json']));
  const latest = Array.isArray(metadata) ? metadata.at(-1) : metadata;
  if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(latest)) throw new Error('Invalid GigaChat registry version');
  const destination = join(agentDir, 'npm/node_modules/@dev-sergeev/pi-gigachat');
  try {
    const installed = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    if (installed.version === latest) return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  // Stage independently: nested npm must not rewrite the outer install's lockfile.
  const stage = await mkdtemp(join(agentDir, '.datalab-gigachat-'));
  const backup = `${destination}.datalab-${randomUUID()}`;
  const replacement = join(stage, 'replacement');
  let moved = false;
  try {
    await npm(['install', '--prefix', stage, `@dev-sergeev/pi-gigachat@${latest}`,
      '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund']);
    await cp(join(stage, 'node_modules/@dev-sergeev/pi-gigachat'), replacement, { recursive: true });
    // Preserve the staged dependency tree so compiled ESM imports stay resolvable.
    await cp(join(stage, 'node_modules'), join(replacement, 'node_modules'), { recursive: true });
    await mkdir(dirname(destination), { recursive: true });
    if (existsSync(destination)) { await rename(destination, backup); moved = true; }
    await rename(replacement, destination);
    if (moved) { await rm(backup, { recursive: true, force: true }); moved = false; }
  } catch (error) {
    if (moved && !existsSync(destination)) await rename(backup, destination);
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
