import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAgentSession, SettingsManager, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { fork } from 'node:child_process';

const fixtures = globalThis[Symbol.for('datalab-kit.enhanced-broker-test.fixtures')] ??= new Map();

export async function brokerSandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'datalab-enhanced-broker-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return { cwd, agentDir };
}

export async function brokerSession(t, sandbox, { parent, subagent = false, agentName = null, answer = 'yes', veto = () => null, hasUI = true, version = 1, upstreamVersion = '33.0.5' } = {}) {
  const id = randomUUID();
  const state = { context: undefined, broker: undefined };
  const prompts = [];
  fixtures.set(id, state);
  state.adapter = { version, upstreamVersion, veto, agentName: () => agentName, isSubagent: () => subagent, parentSessionId: () => typeof parent === 'function' ? parent() : parent };
  const extensionPath = join(sandbox.agentDir, `broker-${id}.mjs`);
  await writeFile(extensionPath, `import * as broker from ${JSON.stringify(pathToFileURL(resolve('dist/enhanced-runtime.js')).href)};
export default function(pi) {
  const state = globalThis[Symbol.for('datalab-kit.enhanced-broker-test.fixtures')].get(${JSON.stringify(id)});
  state.broker = broker;
  broker.registerEnhancedAdapter(pi, state.adapter);
  pi.on('session_start', (_event, ctx) => { state.context = ctx; });
}`);
  const settingsManager = SettingsManager.create(sandbox.cwd, sandbox.agentDir, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({ ...sandbox, settingsManager, additionalExtensionPaths: [extensionPath] });
  await resourceLoader.reload();
  const { session, extensionsResult } = await createAgentSession({ ...sandbox, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(sandbox.cwd) });
  t.after(async () => {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    fixtures.delete(id);
  });
  assert.deepEqual(extensionsResult.errors, []);
  const ui = { ...session.extensionRunner.getUIContext(),
    input: async (...args) => { prompts.push(args); return typeof answer === 'function' ? answer(...args) : answer; },
  };
  await session.bindExtensions({ uiContext: hasUI ? ui : undefined, mode: hasUI ? 'rpc' : 'print' });
  return {
    session, prompts, state,
    get context() { return state.context; },
    get sessionId() { return session.sessionManager.getSessionId(); },
    ready() { return state.broker.isEnhancedAdapterReady(state.context); },
    authorize(request) { return state.broker.authorizeEnhancedApproval(state.context, request); },
    shutdown() { return session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); },
  };
}

export function dangerousRequest(command = 'rm important.csv', agentName = null) {
  return { command, reasons: ['Deletes data'], cwd: '/project', toolName: 'bash', agentName,
    policyChecks: [{ surface: 'bash', matchValues: [command] }],
  };
}

export async function brokerProcess(t, sandbox, parentSessionId) {
  const script = join(sandbox.agentDir, `broker-process-${randomUUID()}.mjs`);
  await writeFile(script, `import { brokerSession } from ${JSON.stringify(import.meta.url)};
const cleanup = [];
const session = await brokerSession({ after: fn => cleanup.unshift(fn) }, ${JSON.stringify(sandbox)}, {
  subagent: true, parent: ${JSON.stringify(parentSessionId)}, agentName: 'worker', hasUI: false,
});
process.on('message', async message => {
  if (message.type === 'authorize') process.send({ type: 'result', id: message.id, approved: await session.authorize(message.request) });
  if (message.type === 'shutdown') { for (const fn of cleanup) await fn(); process.disconnect(); }
});
process.send({ type: 'ready', sessionId: session.sessionId });`);
  const child = fork(script, [], { env: { ...process.env, PI_CODING_AGENT_DIR: sandbox.agentDir }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const pending = new Map();
  const ready = Promise.withResolvers();
  child.on('message', message => {
    if (message.type === 'ready') ready.resolve(message.sessionId);
    if (message.type === 'result') { pending.get(message.id)?.resolve(message.approved); pending.delete(message.id); }
  });
  child.on('exit', code => {
    ready.reject(new Error(`Broker process exited ${code}: ${output}`));
    for (const operation of pending.values()) operation.reject(new Error(`Broker process exited ${code}: ${output}`));
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = Promise.withResolvers();
    child.once('exit', exited.resolve);
    child.send({ type: 'shutdown' });
    const kill = setTimeout(() => child.kill(), 2000);
    await exited.promise;
    clearTimeout(kill);
  });
  const sessionId = await ready.promise;
  return { child, sessionId, authorize(request) {
    const id = randomUUID();
    const result = Promise.withResolvers();
    pending.set(id, result);
    child.send({ type: 'authorize', id, request });
    return result.promise;
  } };
}
