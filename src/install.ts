import { mkdir, readFile, rename, rm, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const gigaChatPackageSource = 'npm:@dev-sergeev/pi-gigachat';
const gigaChatVersion: string = createRequire(import.meta.url)('../package.json').dependencies['@dev-sergeev/pi-gigachat'];
export const gigaChatSource = `${gigaChatPackageSource}@${gigaChatVersion}`;
const previousGigaChatSource = `${gigaChatPackageSource}@0.6.4`;
const execFileAsync = promisify(execFile);

export function managedAgentDir(packageRoot: string): string | undefined {
  const npmRoot = resolve(packageRoot, '../../..');
  return basename(npmRoot) === 'npm' && basename(resolve(packageRoot, '../..')) === 'node_modules'
    ? dirname(npmRoot) : undefined;
}

export function isGigaChatSource(entry: unknown): boolean {
  const source = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'source' in entry ? entry.source : undefined;
  return typeof source === 'string' && (source === gigaChatPackageSource || source.startsWith(`${gigaChatPackageSource}@`));
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
  const existing = Array.isArray(settings.packages) ? settings.packages.find(isGigaChatSource) : undefined;
  if (!existing) return false;
  const source = typeof existing === 'string' ? existing : existing.source;
  if (source !== previousGigaChatSource) return true;
  if (typeof existing === 'object' && existing.extensions !== undefined) return true;
  // Pi skips an old exact source when the managed copy is already newer.
  try {
    const installed = JSON.parse(await readFile(join(agentDir, 'npm/node_modules/@dev-sergeev/pi-gigachat/package.json'), 'utf8'));
    return `${gigaChatPackageSource}@${installed.version}` === source;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Preserve user fields and filters; migrate former kit sources to this release. */
export async function registerGigaChat(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const lock = join(agentDir, 'settings.json.lock');
  await mkdir(lock);
  const temp = join(agentDir, `.datalab-settings-${randomUUID()}.tmp`);
  try {
    const settings = await readSettings(agentDir);
    if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error('Pi packages must be an array');
    const packages = (settings.packages ?? []) as unknown[];
    const existing = packages.find(isGigaChatSource);
    const source = typeof existing === 'string' ? existing : existing && typeof existing === 'object' && 'source' in existing ? existing.source : undefined;
    if (existing && source !== gigaChatPackageSource && source !== previousGigaChatSource) return;
    settings.packages = existing
      ? packages.map(entry => entry !== existing ? entry : typeof entry === 'string' ? gigaChatSource : { ...entry as object, source: gigaChatSource })
      : [...packages, gigaChatSource];
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
  // Preserve user versions except the known pin supplied by the previous kit.
  if (typeof source === 'string' && source !== gigaChatPackageSource && source !== gigaChatSource && source !== previousGigaChatSource) return;
  await refreshGigaChat(agentDir);
  await registerGigaChat(agentDir);
}

async function npm(args: string[]): Promise<string> {
  const command = process.env.npm_execpath;
  const result = command
    ? await execFileAsync(process.execPath, [command, ...args], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    : await execFileAsync('npm', args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

async function refreshGigaChat(agentDir: string): Promise<void> {
  const destination = join(agentDir, 'npm/node_modules/@dev-sergeev/pi-gigachat');
  try {
    const installed = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    if (installed.version === gigaChatVersion) return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  // Stage independently: nested npm must not rewrite the outer install's lockfile.
  const stage = await mkdtemp(join(agentDir, '.datalab-gigachat-'));
  const backup = `${destination}.datalab-${randomUUID()}`;
  const replacement = join(stage, 'replacement');
  let moved = false;
  try {
    await npm(['install', '--prefix', stage, `@dev-sergeev/pi-gigachat@${gigaChatVersion}`,
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
