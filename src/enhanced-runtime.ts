import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { join, resolve } from 'node:path';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { ENHANCED_ADAPTER_VERSION, ENHANCED_READINESS_KEY, PERMISSION_SYSTEM_VERSION } from './enhanced-types.js';
import type { EnhancedAdapter, EnhancedApprovalRequest, EnhancedReadiness } from './enhanced-types.js';
import { requestEnhancedApproval } from './enhanced-ui.js';

interface Registration {
  adapter: EnhancedAdapter;
  entry?: SessionEntry;
  failed: boolean;
}

interface SessionEntry {
  registration: Registration;
  ctx: ExtensionContext;
  manager: ExtensionContext['sessionManager'];
  sessionId: string;
  agentDir: string;
  controller: AbortController;
  queue: Promise<unknown>;
  owner?: Owner;
  directory?: string;
  inbox?: string;
  timer?: NodeJS.Timeout;
  pending: Map<string, AbortController>;
  consumed: Set<string>;
}

interface Registry {
  sessions: Map<string, SessionEntry>;
  managers: WeakMap<object, SessionEntry>;
  registrations: WeakMap<object, Registration>;
}

const REGISTRY_KEY = Symbol.for('datalab-kit.enhanced-approval.registry.v1');
const READINESS_KEY = Symbol.for(ENHANCED_READINESS_KEY);
const globals = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry; [READINESS_KEY]?: EnhancedReadiness };
const registry = globals[REGISTRY_KEY] ??= {
  sessions: new Map(), managers: new WeakMap(), registrations: new WeakMap(),
};
globals[READINESS_KEY] = {
  version: ENHANCED_ADAPTER_VERSION,
  upstreamVersion: PERMISSION_SYSTEM_VERSION,
  isReady: isEnhancedAdapterReady,
};

interface Owner {
  version: number;
  sessionId: string;
  instanceId: string;
  secret: string;
  pid: number;
  parentSessionId: string | null;
  isSubagent: boolean;
  agentName: string | null;
  heartbeat: number;
}

interface Hop { sessionId: string; instanceId: string }

interface Envelope {
  version: number;
  id: string;
  targetSessionId: string;
  targetInstanceId: string;
  targetSecret: string;
  route: Hop[];
  deadline: number;
  digest: string;
  request: EnhancedApprovalRequest;
}

const TIMEOUT = 600000;
const HEARTBEAT = 1000;
const STALE = 5000;
const MAX_DATA = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POLICY_SURFACES: Record<string, true> = {
  bash: true, path: true, path_read: true, path_write: true,
  external_directory: true, external_directory_read: true, external_directory_write: true,
};

function sessionDirectory(agentDir: string, sessionId: string): string {
  return join(agentDir, 'enhanced-approval-v1', 'sessions', createHash('sha256').update(sessionId).digest('hex'));
}


function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700, recursive: false });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe broker directory');
}

function readPrivate(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_DATA
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe broker file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

function writePrivate(path: string, value: unknown, replace = false): void {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > MAX_DATA) throw new Error('Oversized broker message');
  const temporary = replace ? `${path}.${randomUUID()}.tmp` : path;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); }
  finally { closeSync(fd); }
  if (replace) {
    try { renameSync(temporary, path); }
    finally { try { unlinkSync(temporary); } catch { /* Already renamed. */ } }
  }
}

function readOwner(agentDir: string, sessionId: string): Owner | undefined {
  try {
    const directory = sessionDirectory(agentDir, sessionId);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) return undefined;
    const value = readPrivate(join(directory, 'owner.json'));
    if (!keys(value, ['version', 'sessionId', 'instanceId', 'secret', 'pid', 'parentSessionId', 'isSubagent', 'agentName', 'heartbeat'])
      || value.version !== ENHANCED_ADAPTER_VERSION || value.sessionId !== sessionId
      || typeof value.instanceId !== 'string' || !UUID.test(value.instanceId)
      || typeof value.secret !== 'string' || !UUID.test(value.secret)
      || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1
      || !(value.parentSessionId === null || text(value.parentSessionId, 1024))
      || typeof value.isSubagent !== 'boolean' || !(value.agentName === null || text(value.agentName, 256))
      || typeof value.heartbeat !== 'number' || !Number.isSafeInteger(value.heartbeat)
      || Date.now() - value.heartbeat > STALE || value.heartbeat > Date.now() + HEARTBEAT) return undefined;
    return value as unknown as Owner;
  } catch { return undefined; }
}

function publish(entry: SessionEntry): void {
  ensurePrivateDirectory(join(entry.agentDir, 'enhanced-approval-v1'));
  ensurePrivateDirectory(join(entry.agentDir, 'enhanced-approval-v1', 'sessions'));
  const directory = sessionDirectory(entry.agentDir, entry.sessionId);
  ensurePrivateDirectory(directory);
  if (readOwner(entry.agentDir, entry.sessionId)) throw new Error('Session already published');
  const adapter = entry.registration.adapter;
  const isSubagent = adapter.isSubagent(entry.ctx);
  const parentSessionId = adapter.parentSessionId(entry.ctx) ?? null;
  const agentName = adapter.agentName(entry.ctx);
  if (typeof isSubagent !== 'boolean' || !(agentName === null || text(agentName, 256))
    || !(parentSessionId === null || text(parentSessionId, 1024))) throw new Error('Invalid adapter identity');
  const owner: Owner = { version: ENHANCED_ADAPTER_VERSION, sessionId: entry.sessionId, instanceId: randomUUID(),
    secret: randomUUID(), pid: process.pid, parentSessionId, isSubagent, agentName, heartbeat: Date.now() };
  const inbox = join(directory, `inbox-${owner.instanceId}`);
  mkdirSync(inbox, { mode: 0o700, recursive: false });
  entry.owner = owner;
  entry.directory = directory;
  entry.inbox = inbox;
  writePrivate(join(directory, 'owner.json'), owner, true);
  entry.timer = setInterval(() => {
    if (!live(entry)) return;
    try {
      if (Date.now() - owner.heartbeat >= HEARTBEAT) {
        owner.heartbeat = Date.now();
        owner.parentSessionId = adapter.parentSessionId(entry.ctx) ?? null;
        owner.agentName = adapter.agentName(entry.ctx);
        owner.isSubagent = adapter.isSubagent(entry.ctx);
        writePrivate(join(directory, 'owner.json'), owner, true);
      }
      pollInbox(entry);
    } catch { stop(entry); }
  }, 75);
  entry.timer.unref();
}

function sessionKey(agentDir: string, sessionId: string): string {
  return JSON.stringify([agentDir, sessionId]);
}

function validAdapter(adapter: EnhancedAdapter): boolean {
  return adapter?.version === ENHANCED_ADAPTER_VERSION && adapter.upstreamVersion === PERMISSION_SYSTEM_VERSION
    && typeof adapter.veto === 'function' && typeof adapter.parentSessionId === 'function'
    && typeof adapter.agentName === 'function' && typeof adapter.isSubagent === 'function';
}

function stop(entry: SessionEntry): void {
  entry.controller.abort();
  clearInterval(entry.timer);
  for (const pending of entry.pending.values()) pending.abort();
  if (entry.directory && entry.owner) {
    try {
      const owner = readPrivate(join(entry.directory, 'owner.json')) as Partial<Owner>;
      if (owner.instanceId === entry.owner.instanceId) unlinkSync(join(entry.directory, 'owner.json'));
    } catch { /* Shutdown must not remove another session generation. */ }
  }
  if (entry.inbox) {
    try { rmSync(entry.inbox, { recursive: true, force: true }); } catch { /* Fail closed even if cleanup fails. */ }
  }
  const key = sessionKey(entry.agentDir, entry.sessionId);
  if (registry.sessions.get(key) === entry) registry.sessions.delete(key);
  if (registry.managers.get(entry.manager) === entry) registry.managers.delete(entry.manager);
  if (entry.registration.entry === entry) entry.registration.entry = undefined;
}

function live(entry: SessionEntry): boolean {
  try {
    const owner = readOwner(entry.agentDir, entry.sessionId);
    if (!entry.controller.signal.aborted && !entry.registration.failed && validAdapter(entry.registration.adapter)
      && entry.ctx.sessionManager.getSessionId() === entry.sessionId
      && registry.sessions.get(sessionKey(entry.agentDir, entry.sessionId)) === entry
      && owner?.instanceId === entry.owner?.instanceId && owner?.secret === entry.owner?.secret
      && entry.owner !== undefined && entry.inbox !== undefined && existsSync(entry.inbox)) return true;
  } catch { /* Invalid integration must fail closed. */ }
  stop(entry);
  return false;
}

/** Registration is inert until Pi starts the session successfully. */
export function registerEnhancedAdapter(pi: ExtensionAPI, adapter: EnhancedAdapter): void {
  const previous = registry.registrations.get(pi);
  if (previous?.entry) stop(previous.entry);
  if (previous) previous.failed = true;
  const registration: Registration = { adapter, failed: !validAdapter(adapter) };
  registry.registrations.set(pi, registration);
  if (registration.failed) return;
  try {
    pi.on('session_start', (_event, ctx) => {
      if (registration.failed) return;
      if (registration.entry) stop(registration.entry);
      try {
        const sessionId = ctx.sessionManager.getSessionId();
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 1024) throw new Error('Invalid session');
        const entry: SessionEntry = { registration, ctx, manager: ctx.sessionManager, sessionId, agentDir: resolve(getAgentDir()),
          controller: new AbortController(), queue: Promise.resolve(), pending: new Map(), consumed: new Set() };
        const key = sessionKey(entry.agentDir, sessionId);
        if (registry.sessions.has(key)) throw new Error('Duplicate live session');
        registry.sessions.set(key, entry);
        registry.managers.set(ctx.sessionManager, entry);
        registration.entry = entry;
        publish(entry);
      } catch {
        if (registration.entry) stop(registration.entry);
        registration.failed = true;
      }
    });
    pi.on('session_shutdown', () => {
      if (registration.entry) stop(registration.entry);
    });
  } catch {
    registration.failed = true;
    if (registration.entry) stop(registration.entry);
  }
}

export function isEnhancedAdapterReady(ctx: ExtensionContext): boolean {
  try {
    const entry = registry.managers.get(ctx.sessionManager);
    return entry !== undefined && live(entry);
  } catch { return false; }
}

function text(value: unknown, max = 262144): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

/** Only data in the public request contract crosses the human boundary. */
function snapshot(value: unknown): EnhancedApprovalRequest | undefined {
  if (!keys(value, ['command', 'reasons', 'cwd', 'toolName', 'agentName', 'policyChecks'])) return undefined;
  if (!text(value.command) || !text(value.cwd, 16384) || !text(value.toolName, 256)
    || !(value.agentName === null || text(value.agentName, 256))
    || !Array.isArray(value.reasons) || value.reasons.length === 0 || value.reasons.length > 128
    || !value.reasons.every(reason => text(reason, 16384))
    || !Array.isArray(value.policyChecks) || value.policyChecks.length === 0 || value.policyChecks.length > 1024) return undefined;
  const policyChecks = [];
  for (const check of value.policyChecks) {
    if (!keys(check, ['surface', 'matchValues']) || !text(check.surface, 256) || !Object.hasOwn(POLICY_SURFACES, check.surface)
      || !Array.isArray(check.matchValues) || check.matchValues.length === 0 || check.matchValues.length > 1024
      || !check.matchValues.every(match => typeof match === 'string' && match.length <= 262144 && !match.includes('\0'))) return undefined;
    policyChecks.push(Object.freeze({ surface: check.surface, matchValues: Object.freeze([...check.matchValues]) }) as { surface: string; matchValues: string[] });
  }
  return Object.freeze({ command: value.command, cwd: value.cwd, toolName: value.toolName, agentName: value.agentName,
    reasons: Object.freeze([...value.reasons]) as string[], policyChecks: Object.freeze(policyChecks) });
}

function cancelable<T>(promise: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback);
  // The package compiles against ES2022; Promise.withResolvers is not in that lib.
  return new Promise(resolveResult => {
    const aborted = () => resolveResult(fallback);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { signal.removeEventListener('abort', aborted); resolveResult(signal.aborted ? fallback : value); },
      () => { signal.removeEventListener('abort', aborted); resolveResult(fallback); });
  });
}

function validateEnvelope(entry: SessionEntry, value: unknown): Envelope | undefined {
  if (!entry.owner || !keys(value, ['version', 'id', 'targetSessionId', 'targetInstanceId', 'targetSecret', 'route', 'deadline', 'digest', 'request'])
    || value.version !== ENHANCED_ADAPTER_VERSION || typeof value.id !== 'string' || !UUID.test(value.id)
    || value.targetSessionId !== entry.sessionId || value.targetInstanceId !== entry.owner.instanceId
    || value.targetSecret !== entry.owner.secret || !Array.isArray(value.route) || value.route.length === 0 || value.route.length > 32
    || typeof value.deadline !== 'number' || !Number.isSafeInteger(value.deadline)
    || value.deadline <= Date.now() || value.deadline > Date.now() + TIMEOUT
    || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)) return undefined;
  const request = snapshot(value.request);
  if (!request || createHash('sha256').update(JSON.stringify(request)).digest('hex') !== value.digest) return undefined;
  const seen = new Set<string>([entry.sessionId]);
  const route: Hop[] = [];
  for (const hop of value.route) {
    if (!keys(hop, ['sessionId', 'instanceId']) || !text(hop.sessionId, 1024)
      || typeof hop.instanceId !== 'string' || !UUID.test(hop.instanceId) || seen.has(hop.sessionId)) return undefined;
    seen.add(hop.sessionId);
    route.push({ sessionId: hop.sessionId, instanceId: hop.instanceId });
  }
  for (let index = 0; index < route.length; index++) {
    const hop = route[index]!;
    const owner = readOwner(entry.agentDir, hop.sessionId);
    const next = route[index + 1]?.sessionId ?? entry.sessionId;
    if (!owner || owner.instanceId !== hop.instanceId || !owner.isSubagent || owner.parentSessionId !== next
      || (index === 0 && owner.agentName !== request.agentName)) return undefined;
  }
  return { version: ENHANCED_ADAPTER_VERSION, id: value.id, targetSessionId: entry.sessionId,
    targetInstanceId: entry.owner.instanceId, targetSecret: entry.owner.secret, route,
    deadline: value.deadline, digest: value.digest, request };
}

function pollInbox(entry: SessionEntry): void {
  if (!entry.inbox || !live(entry)) return;
  for (const file of readdirSync(entry.inbox)) {
    if (!file.endsWith('.request.json')) continue;
    const id = file.slice(0, -'.request.json'.length);
    if (!UUID.test(id) || entry.pending.has(id) || entry.consumed.has(id)) continue;
    const path = join(entry.inbox, file);
    let envelope: Envelope | undefined;
    try { envelope = validateEnvelope(entry, readPrivate(path)); } catch { /* Invalid input never reaches UI. */ }
    if (!envelope || envelope.id !== id) {
      try { unlinkSync(path); } catch { /* Sender may already have canceled. */ }
      continue;
    }
    entry.consumed.add(id);
    const controller = new AbortController();
    entry.pending.set(id, controller);
    void serveEnvelope(entry, envelope, path, controller);
  }
}

async function serveEnvelope(entry: SessionEntry, envelope: Envelope, path: string, controller: AbortController): Promise<void> {
  const signal = AbortSignal.any([entry.controller.signal, controller.signal]);
  const fixed = JSON.stringify(envelope);
  const monitor = setInterval(() => {
    try {
      const current = validateEnvelope(entry, readPrivate(path));
      if (!live(entry) || !current || JSON.stringify(current) !== fixed) controller.abort();
    } catch { controller.abort(); }
  }, 75);
  try {
    const approved = await receive(entry, envelope.request, signal, new Set(envelope.route.map(hop => hop.sessionId)));
    const current = validateEnvelope(entry, readPrivate(path));
    if (!live(entry) || signal.aborted || !current || JSON.stringify(current) !== fixed || !entry.inbox) return;
    writePrivate(join(entry.inbox, `${envelope.id}.response.json`), {
      version: ENHANCED_ADAPTER_VERSION, id: envelope.id, targetSessionId: entry.sessionId,
      targetInstanceId: envelope.targetInstanceId, route: envelope.route, digest: envelope.digest, approved,
    });
  } catch { /* Broken or canceled transport cannot authorize. */ }
  finally {
    clearInterval(monitor);
    entry.pending.delete(envelope.id);
    try { unlinkSync(path); } catch { /* Sender or shutdown may own cleanup. */ }
  }
}

async function relay(entry: SessionEntry, parentSessionId: string, request: EnhancedApprovalRequest, signal: AbortSignal, visited: Set<string>): Promise<boolean> {
  if (!entry.owner || !live(entry) || signal.aborted || visited.size > 32) return false;
  const parent = readOwner(entry.agentDir, parentSessionId);
  if (!parent) return false;
  const route: Hop[] = [];
  for (const sessionId of visited) {
    const owner = readOwner(entry.agentDir, sessionId);
    if (!owner) return false;
    route.push({ sessionId, instanceId: owner.instanceId });
  }
  const id = randomUUID();
  const inbox = join(sessionDirectory(entry.agentDir, parentSessionId), `inbox-${parent.instanceId}`);
  const requestPath = join(inbox, `${id}.request.json`);
  const responsePath = join(inbox, `${id}.response.json`);
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const envelope: Envelope = { version: ENHANCED_ADAPTER_VERSION, id, targetSessionId: parentSessionId,
    targetInstanceId: parent.instanceId, targetSecret: parent.secret, route, deadline: Date.now() + TIMEOUT, digest, request };
  try {
    const stat = lstatSync(inbox);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) return false;
    writePrivate(requestPath, envelope, true);
    while (live(entry) && !signal.aborted && Date.now() < envelope.deadline) {
      const current = readOwner(entry.agentDir, parentSessionId);
      if (!current || current.instanceId !== parent.instanceId || current.secret !== parent.secret) return false;
      if (existsSync(responsePath)) {
        const response = readPrivate(responsePath);
        return keys(response, ['version', 'id', 'targetSessionId', 'targetInstanceId', 'route', 'digest', 'approved'])
          && response.version === ENHANCED_ADAPTER_VERSION && response.id === id
          && response.targetSessionId === parentSessionId && response.targetInstanceId === parent.instanceId
          && JSON.stringify(response.route) === JSON.stringify(route) && response.digest === digest && response.approved === true;
      }
      if (!existsSync(requestPath)) return false;
      await pause(50, undefined, { signal });
    }
  } catch { return false; }
  finally {
    for (const path of [requestPath, responsePath]) {
      try { unlinkSync(path); } catch { /* Parent shutdown may already have removed the generation. */ }
    }
  }
  return false;
}

async function applyVeto(entry: SessionEntry, request: EnhancedApprovalRequest): Promise<string | null> {
  try {
    const result = await entry.registration.adapter.veto(request);
    if (result === null || typeof result === 'string') return result;
  } catch { /* Failed policy integration cannot remain ready. */ }
  entry.registration.failed = true;
  stop(entry);
  return 'Approval unavailable';
}

async function receive(entry: SessionEntry, request: EnhancedApprovalRequest, signal: AbortSignal, visited: Set<string>): Promise<boolean> {
  if (!live(entry) || signal.aborted || visited.has(entry.sessionId) || visited.size > 32) return false;
  const route = new Set(visited).add(entry.sessionId);
  const combined = AbortSignal.any([signal, entry.controller.signal]);
  try {
    if (await cancelable(applyVeto(entry, request), combined, 'Approval unavailable') !== null) return false;
    if (!live(entry) || combined.aborted) return false;
    if (entry.registration.adapter.isSubagent(entry.ctx)) {
      const parent = entry.registration.adapter.parentSessionId(entry.ctx);
      if (!text(parent, 1024) || route.has(parent)) return false;
      const target = registry.sessions.get(sessionKey(entry.agentDir, parent));
      const approved = await (target ? receive(target, request, combined, route) : relay(entry, parent, request, combined, route));
      if (!approved || !live(entry) || combined.aborted) return false;
      if (await cancelable(applyVeto(entry, request), combined, 'Approval unavailable') !== null) return false;
      return live(entry) && !combined.aborted && entry.registration.adapter.isSubagent(entry.ctx)
        && entry.registration.adapter.parentSessionId(entry.ctx) === parent;
    }
    if (!entry.ctx.hasUI) return false;
    const ask = entry.queue.then(async () => {
      if (!live(entry) || combined.aborted || !entry.ctx.hasUI || entry.registration.adapter.isSubagent(entry.ctx)) return false;
      // Policy may change while another child owns the inline input.
      if (await cancelable(applyVeto(entry, request), combined, 'Approval unavailable') !== null) return false;
      const approved = await cancelable(requestEnhancedApproval(entry.ctx, request, combined), combined, false);
      if (!approved || !live(entry) || combined.aborted) return false;
      // A fresh human answer cannot override policy changed while input was open.
      if (await cancelable(applyVeto(entry, request), combined, 'Approval unavailable') !== null) return false;
      return live(entry) && !combined.aborted && !entry.registration.adapter.isSubagent(entry.ctx);
    });
    entry.queue = ask.then(() => undefined, () => undefined);
    return cancelable(ask, combined, false);
  } catch {
    entry.registration.failed = true;
    stop(entry);
    return false;
  }
}

/** One unchanged invocation, never a grant or an ordinary upstream authorization. */
export async function authorizeEnhancedApproval(ctx: ExtensionContext, request: EnhancedApprovalRequest): Promise<boolean> {
  let entry: SessionEntry | undefined;
  let callerSignal: AbortSignal | undefined;
  try {
    entry = registry.managers.get(ctx.sessionManager);
    callerSignal = ctx.signal;
    if (!entry || !live(entry)) return false;
  } catch { return false; }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, entry.controller.signal, ...(callerSignal ? [callerSignal] : [])]);
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const principal = entry.registration.adapter.agentName(ctx);
    if (entry.owner && entry.directory) {
      entry.owner.agentName = principal;
      entry.owner.parentSessionId = entry.registration.adapter.parentSessionId(ctx) ?? null;
      entry.owner.isSubagent = entry.registration.adapter.isSubagent(ctx);
      entry.owner.heartbeat = Date.now();
      writePrivate(join(entry.directory, 'owner.json'), entry.owner, true);
    }
    const fixed = snapshot({ ...request, agentName: principal });
    if (!fixed) return false;
    const fingerprint = JSON.stringify(fixed);
    const approved = await receive(entry, fixed, signal, new Set());
    const current = snapshot({ ...request, agentName: entry.registration.adapter.agentName(ctx) });
    return approved && !signal.aborted && live(entry) && JSON.stringify(current) === fingerprint;
  } catch {
    entry.registration.failed = true;
    stop(entry);
    return false;
  }
  finally { clearTimeout(timeout); }
}
