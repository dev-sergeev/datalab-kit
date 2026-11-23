import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const kit = '@dev-sergeev/datalab-kit';
const permissionName = 'permission-system';
const permissionSource = `npm:${permissionName}`;
const legacyPermissionName = '@gotgenes/pi-permission-system';
const legacyPermissionSource = `npm:${legacyPermissionName}`;
const legacyPermissionNames = [legacyPermissionName, '@mzwing/pi-permission-auto-review'];
const components = [
  '@dev-sergeev/pi-gigachat',
  '@juicesharp/rpiv-ask-user-question',
  'pi-powerline-footer',
  permissionName,
  '@narumitw/pi-plan-mode',
  '@gotgenes/pi-subagents',
  '@capdiem/pi-todo',
  'pi-rewind',
  '@dev-sergeev/pi-recap',
  '@pi-plugins/elapsed',
  'pi-toggle-skills',
  '@zigai/pi-mention-skill',
].map(name => `npm:${name}`);

type Plan = { version: 1; pending: string[]; remove: string[]; complete: boolean; normalize?: string };
type Entry = string | { source: string };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sourceOf = (entry: Entry): string => typeof entry === 'string' ? entry : entry.source;
const npmName = (source: string): string | undefined =>
  /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@.+)?$/.exec(source)?.[1];

function pathFrom(source: string, base = process.cwd()): string {
  const expanded = source === '~' ? homedir() : source.startsWith('~/') ? join(homedir(), source.slice(2))
    : source.startsWith('file://') ? fileURLToPath(source) : source;
  return resolve(base, expanded);
}

async function json(path: string): Promise<unknown> {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function packages(dir: string): Promise<Entry[]> {
  const settings = await json(join(dir, 'settings.json'));
  if (settings === undefined) return [];
  if (!object(settings)) throw new Error(`Pi settings must be a JSON object: ${dir}`);
  if (settings.packages === undefined) return [];
  if (!Array.isArray(settings.packages) || settings.packages.some(entry => {
    const source = typeof entry === 'string' ? entry : object(entry) ? entry.source : undefined;
    if (typeof source !== 'string' || !source.trim() || source !== source.trim() || source.includes('\0')) return true;
    if (typeof entry === 'string') return false;
    return ['extensions', 'skills', 'prompts', 'themes'].some(key =>
      entry[key] !== undefined && (!Array.isArray(entry[key]) || entry[key].some((item: unknown) => typeof item !== 'string'))) ||
      (entry.autoload !== undefined && typeof entry.autoload !== 'boolean');
  })) throw new Error(`Pi packages must contain valid sources and resource filters: ${dir}`);
  return settings.packages as Entry[];
}

async function packageName(source: string, dir: string): Promise<string | undefined> {
  if (source.startsWith('npm:')) {
    const name = npmName(source);
    if (!name) throw new Error(`Invalid npm source: ${source}`);
    return name;
  }
  let packageDir: string;
  if (/^(git:|https?:\/\/|ssh:\/\/)/i.test(source)) {
    let url = source.replace(/^git:(?!\/\/)/, '').replace(/^git@([^:]+):/, 'https://$1/');
    const hosts: Record<string, string> = { github: 'github.com', gitlab: 'gitlab.com',
      bitbucket: 'bitbucket.org', gist: 'gist.github.com', sourcehut: 'git.sr.ht' };
    if (/^[^./:@\s][^/:\s]*\/[^/#@\s]+(?:[#@].*)?$/.test(url)) url = `github.com/${url}`;
    url = url.replace(/^(github|gitlab|bitbucket|gist|sourcehut):/, (_, host: string) => `${hosts[host]}/`);
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    const host = parsed.hostname.replace(/^www\.(?=(?:github\.com|gitlab\.com|bitbucket\.org|gist\.github\.com|git\.sr\.ht)$)/, '');
    let repo = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').split('@')[0]!);
    if (['github.com', 'bitbucket.org', 'git.sr.ht'].includes(host)) repo = repo.split('/').slice(0, 2).join('/');
    if (host === 'gist.github.com' && !repo.includes('/')) repo = `null/${repo}`;
    repo = repo.replace(/\.git$/, '');
    if (!repo || repo.split('/').includes('..') || repo.includes('\0') || repo.includes('\\')) throw new Error(`Invalid Git source: ${source}`);
    packageDir = join(dir, 'git', host, repo);
  } else {
    packageDir = pathFrom(source, dir);
  }
  let manifest: unknown;
  try { manifest = await json(join(packageDir, 'package.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error; }
  if (object(manifest) && typeof manifest.name === 'string') return manifest.name;
  if (/(?:^|[/:])datalab-kit(?:[.@/#]|$)/.test(source)) {
    throw new Error(`Cannot identify former Datalab Kit source ${source}; remove it with pi uninstall before installing.`);
  }
  return undefined;
}

function validatePlan(value: unknown): asserts value is Plan {
  if (!object(value) || value.version !== 1 || typeof value.complete !== 'boolean' ||
      !Array.isArray(value.pending) || value.pending.some(source => source !== legacyPermissionSource && !components.includes(source)) ||
      new Set(value.pending.map(source => source === legacyPermissionSource ? permissionSource : source)).size !== value.pending.length ||
      !Array.isArray(value.remove) || value.remove.some(source => typeof source !== 'string' || !source.trim() || source.includes('\0') ||
        (source.startsWith('npm:') && npmName(source) !== kit)) ||
      new Set(value.remove).size !== value.remove.length ||
      (value.normalize !== undefined && value.normalize !== value.pending[0]) ||
      (value.complete && (value.pending.length || value.remove.length))) {
    throw new Error('Invalid Datalab Kit installation marker; refusing to change Pi packages.');
  }
}

function pi(args: string[]): void {
  const result = spawnSync('pi', args, { stdio: 'inherit' });
  if (result.error) throw new Error(`Pi must already be installed and available on PATH: ${result.error.message}`);
  if (result.status !== 0) throw Object.assign(new Error(`pi ${args.join(' ')} failed${result.signal ? ` (${result.signal})` : ''}`),
    { exitCode: result.status ?? 1 });
}

export async function install(args: string[]): Promise<void> {
  if (args.some(arg => !['--local', '--help', '-h'].includes(arg))) throw new Error('Usage: datalab-kit [--local]');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: datalab-kit [--local]\nInstall the kit once using an existing pi command. --local selects the current project.');
    return;
  }
  const local = args.includes('--local');
  const agentDir = pathFrom(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'));
  const projectDir = join(process.cwd(), '.pi');
  const dir = local ? projectDir : agentDir;
  const marker = join(dir, '.datalab-kit-install.json');
  const saved = await json(marker);
  if (saved !== undefined) validatePlan(saved);
  await packages(agentDir);
  await packages(projectDir);
  if (saved?.complete) return;
  if (Number.parseInt(process.versions.node, 10) < 24) {
    throw new Error('Datalab Kit requires Node.js 24 or later to install permission-system.');
  }
  pi(['--version']);
  await mkdir(dir, { recursive: true });
  const lock = `${marker}.lock`;
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another kit installer is active, or an interrupted run left ${lock}. Remove this lock only if no installer is running.`);
    throw error;
  }
  const temporary = `${marker}.${process.pid}.tmp`;
  const save = async (plan: Plan) => {
    await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, marker);
  };
  try {
    const current = await json(marker);
    if (current !== undefined) validatePlan(current);
    if (current?.complete) return;
    const entries = await packages(dir);
    const names = await Promise.all(entries.map(entry => packageName(sourceOf(entry), dir)));
    const otherDir = local ? agentDir : projectDir;
    const otherNames = await Promise.all((await packages(otherDir)).map(entry => packageName(sourceOf(entry), otherDir)));
    const legacy = legacyPermissionNames.find(name => names.includes(name) || otherNames.includes(name));
    if (legacy) {
      throw new Error(`Cannot install ${permissionSource} while npm:${legacy} is configured. Remove the old extension in its Pi scope before retrying; keep its settings files.`);
    }
    const plan: Plan = current ?? {
      version: 1,
      pending: components.filter(source => !names.includes(npmName(source))),
      remove: entries.filter((_, index) => names[index] === kit).map(sourceOf),
      complete: false,
    };
    const legacyIndex = plan.pending.indexOf(legacyPermissionSource);
    if (legacyIndex !== -1) {
      plan.pending[legacyIndex] = permissionSource;
      if (plan.normalize === legacyPermissionSource) delete plan.normalize;
    }
    for (const source of plan.remove) {
      if (entries.some(entry => sourceOf(entry) === source) && await packageName(source, dir) !== kit) {
        throw new Error(`Installation marker contains a non-kit removal: ${source}`);
      }
    }
    await save(plan);
    const scope = local ? ['--local'] : [];
    while (plan.pending.length) {
      const source = plan.pending[0]!;
      const existing = await packages(dir);
      const installed = await Promise.all(existing.map(entry => packageName(sourceOf(entry), dir)));
      const missing = !installed.includes(npmName(source));
      const latest = `${source}@latest`;
      if (missing) {
        pi(['install', latest, ...scope]);
        if (!(await packages(dir)).includes(latest)) {
          throw new Error(`Pi did not persist ${latest}; installation remains pending.`);
        }
        plan.normalize = source;
        await save(plan);
      }
      // Only observed, recorded ownership permits rewriting a source that appeared during an interrupted run.
      if (plan.normalize === source && (await packages(dir)).includes(latest)) {
        pi(['install', source, ...scope]);
        if (!(await packages(dir)).some(entry => sourceOf(entry) === source)) {
          throw new Error(`Pi did not persist ${source}; installation remains pending.`);
        }
      }
      delete plan.normalize;
      plan.pending.shift();
      await save(plan);
    }
    while (plan.remove.length) {
      const source = plan.remove[0]!;
      if ((await packages(dir)).some(entry => sourceOf(entry) === source)) {
        if (await packageName(source, dir) !== kit) throw new Error(`Former kit source changed during installation: ${source}`);
        const commandSource = npmName(source) || /^(git:|https?:\/\/|ssh:\/\/)/i.test(source) ? source : pathFrom(source, dir);
        pi(['uninstall', commandSource, ...scope]);
        if ((await packages(dir)).some(entry => sourceOf(entry) === source)) {
          throw new Error(`Pi did not remove ${source}; migration remains pending.`);
        }
      }
      plan.remove.shift();
      await save(plan);
    }
    plan.complete = true;
    await save(plan);
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
