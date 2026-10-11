import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { brokerSandbox, brokerSession, brokerProcess, dangerousRequest } from './helpers/enhanced-broker.mjs';

test('a protected child call reaches the live human parent and requires a fresh typed approval', async (t) => {
  const sandbox = await brokerSandbox(t);
  const parent = await brokerSession(t, sandbox);
  const child = await brokerSession(t, sandbox, { subagent: true, parent: parent.sessionId, answer: () => { throw new Error('Child cannot decide locally'); } });
  assert.equal(parent.ready(), true);
  assert.equal(child.ready(), true);
  assert.equal(await child.authorize(dangerousRequest('rm important.csv', 'researcher')), true);
  assert.equal(parent.prompts.length, 1);
  assert.equal(child.prompts.length, 0);
  assert.equal(await child.authorize(dangerousRequest('rm important.csv', 'researcher')), true);
  assert.equal(parent.prompts.length, 2, 'a prior yes is not a stored grant');
});

test('a headless process child relays the unchanged call to the actual human process', { timeout: 15000 }, async (t) => {
  const sandbox = await brokerSandbox(t);
  const parent = await brokerSession(t, sandbox);
  const child = await brokerProcess(t, sandbox, parent.sessionId);
  assert.equal(await child.authorize(dangerousRequest('hdfs dfs -ls /', 'fake-main')), true);
  assert.equal(parent.prompts.length, 1);
  assert.equal(await child.authorize(dangerousRequest('hdfs dfs -ls /', 'fake-main')), true);
  assert.equal(parent.prompts.length, 2, 'a process response is consumed, not reusable permission');
});

test('parent raw deny veto sees the fixed child principal and values before any input', async (t) => {
  const sandbox = await brokerSandbox(t);
  const seen = [];
  const parent = await brokerSession(t, sandbox, { veto: request => { seen.push(request); return 'Configured deny'; } });
  const child = await brokerSession(t, sandbox, { subagent: true, parent: parent.sessionId, agentName: 'researcher' });
  const request = dangerousRequest('rm important.csv', 'privileged-main');
  request.policyChecks.push({ surface: 'path', matchValues: ['/project/important.csv'] });
  assert.equal(await child.authorize(request), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agentName, 'researcher');
  assert.deepEqual(seen[0].policyChecks, request.policyChecks);
  assert.equal(parent.prompts.length, 0);
  assert.equal(child.prompts.length, 0);
});

test('local protected calls accept only exact lowercase yes and never remember it', async (t) => {
  const sandbox = await brokerSandbox(t);
  const answers = ['Yes', 'yes ', ' yes', 'YES', '', undefined, 'yes', 'yes'];
  const session = await brokerSession(t, sandbox, { answer: () => answers.shift() });
  for (let index = 0; index < 6; index++) assert.equal(await session.authorize(dangerousRequest()), false);
  assert.equal(await session.authorize(dangerousRequest()), true);
  assert.equal(await session.authorize(dangerousRequest()), true);
  assert.equal(session.prompts.length, 8);
});

test('forwarding through a child parent ends at the human rather than that child UI', { timeout: 15000 }, async (t) => {
  const sandbox = await brokerSandbox(t);
  const human = await brokerSession(t, sandbox);
  const middle = await brokerSession(t, sandbox, { subagent: true, parent: human.sessionId, agentName: 'coordinator',
    answer: () => { throw new Error('A child with UI is still not human authority'); } });
  const leaf = await brokerProcess(t, sandbox, middle.sessionId);
  assert.equal(await leaf.authorize(dangerousRequest('hadoop version')), true);
  assert.equal(human.prompts.length, 1);
  assert.equal(middle.prompts.length, 0);
});

test('unknown policy surfaces and UI metadata never cross the broker contract', async (t) => {
  const sandbox = await brokerSandbox(t);
  const parent = await brokerSession(t, sandbox);
  const child = await brokerSession(t, sandbox, { subagent: true, parent: parent.sessionId });
  const unknown = dangerousRequest();
  unknown.policyChecks[0].surface = 'allowEverything';
  assert.equal(await child.authorize(unknown), false);
  assert.equal(await child.authorize({ ...dangerousRequest(), title: 'Safe read-only operation' }), false);
  assert.equal(parent.prompts.length, 0);
});

test('unsupported adapter version or upstream package keeps readiness false', async (t) => {
  const sandbox = await brokerSandbox(t);
  for (const options of [{ version: 2 }, { upstreamVersion: '33.0.4' }]) {
    const session = await brokerSession(t, sandbox, options);
    assert.equal(session.ready(), false);
    assert.equal(await session.authorize(dangerousRequest()), false);
    assert.equal(session.prompts.length, 0);
  }
});

test('headless roots and missing, self or cyclic parent routes fail closed even with child UI', async (t) => {
  const sandbox = await brokerSandbox(t);
  const headless = await brokerSession(t, sandbox, { hasUI: false });
  assert.equal(await headless.authorize(dangerousRequest()), false);
  const missing = await brokerSession(t, sandbox, { subagent: true, parent: '../missing-parent' });
  assert.equal(await missing.authorize(dangerousRequest()), false);
  let ownId;
  const self = await brokerSession(t, sandbox, { subagent: true, parent: () => ownId });
  ownId = self.sessionId;
  assert.equal(await self.authorize(dangerousRequest()), false);
  let secondId;
  const first = await brokerSession(t, sandbox, { subagent: true, parent: () => secondId });
  const second = await brokerSession(t, sandbox, { subagent: true, parent: first.sessionId });
  secondId = second.sessionId;
  assert.equal(await second.authorize(dangerousRequest()), false);
  for (const session of [headless, missing, self, first, second]) assert.equal(session.prompts.length, 0);
});

test('concurrent children serialize their human inputs without replacing an active ask', async (t) => {
  const sandbox = await brokerSandbox(t);
  const entered = Promise.withResolvers();
  const firstAnswer = Promise.withResolvers();
  let count = 0;
  const parent = await brokerSession(t, sandbox, { answer: () => {
    count++;
    if (count === 1) { entered.resolve(); return firstAnswer.promise; }
    return 'yes';
  } });
  const first = await brokerSession(t, sandbox, { subagent: true, parent: parent.sessionId, agentName: 'one' });
  const second = await brokerSession(t, sandbox, { subagent: true, parent: parent.sessionId, agentName: 'two' });
  const one = first.authorize(dangerousRequest('rm first.csv'));
  const two = second.authorize(dangerousRequest('rm second.csv'));
  await entered.promise;
  await tick();
  assert.equal(parent.prompts.length, 1);
  firstAnswer.resolve('yes');
  assert.deepEqual(await Promise.all([one, two]), [true, true]);
  assert.equal(parent.prompts.length, 2);
});

test('changing the command while the human input is pending invalidates that approval', async (t) => {
  const sandbox = await brokerSandbox(t);
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  const parent = await brokerSession(t, sandbox, { answer: () => { entered.resolve(); return answer.promise; } });
  const request = dangerousRequest('rm first.csv');
  const result = parent.authorize(request);
  await entered.promise;
  request.command = 'rm second.csv';
  answer.resolve('yes');
  assert.equal(await result, false);
});

test('a veto introduced while the human decides cannot be overridden by that pending yes', async (t) => {
  const sandbox = await brokerSandbox(t);
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  let denied = false;
  const parent = await brokerSession(t, sandbox, {
    veto: () => denied ? 'New deny or Plan restriction' : null,
    answer: () => { entered.resolve(); return answer.promise; },
  });
  const result = parent.authorize(dangerousRequest());
  await entered.promise;
  denied = true;
  answer.resolve('yes');
  assert.equal(await result, false);
});

test('an intermediate parent rechecks its veto after the human at the end of the route approves', async (t) => {
  const sandbox = await brokerSandbox(t);
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  let denied = false;
  const human = await brokerSession(t, sandbox, { answer: () => { entered.resolve(); return answer.promise; } });
  const middle = await brokerSession(t, sandbox, {
    subagent: true, parent: human.sessionId,
    veto: () => denied ? 'Intermediate parent entered Plan' : null,
  });
  const leaf = await brokerSession(t, sandbox, { subagent: true, parent: middle.sessionId });
  const result = leaf.authorize(dangerousRequest());
  await entered.promise;
  denied = true;
  answer.resolve('yes');
  assert.equal(await result, false);
});

test('parent shutdown cancels an active child ask and a new session cannot answer for the old parent', async (t) => {
  const sandbox = await brokerSandbox(t);
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  const parent = await brokerSession(t, sandbox, { answer: () => { entered.resolve(); return answer.promise; } });
  const child = await brokerSession(t, sandbox, { subagent: true, parent: parent.sessionId });
  const result = child.authorize(dangerousRequest());
  await entered.promise;
  await parent.shutdown();
  assert.equal(await result, false);
  assert.equal(parent.ready(), false);
  answer.resolve('yes');
  parent.session.sessionManager.newSession();
  await parent.session.extensionRunner.emit({ type: 'session_start', reason: 'new' });
  assert.equal(parent.ready(), true);
  assert.equal(await child.authorize(dangerousRequest()), false);
  assert.equal(parent.prompts.length, 1);
});

test('a process response with a mismatched request binding cannot approve its waiting child', { timeout: 15000 }, async (t) => {
  const sandbox = await brokerSandbox(t);
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  t.after(() => answer.resolve('yes'));
  const parent = await brokerSession(t, sandbox, { answer: () => { entered.resolve(); return answer.promise; } });
  const child = await brokerProcess(t, sandbox, parent.sessionId);
  const result = child.authorize(dangerousRequest('rm bound.csv'));
  await entered.promise;
  const root = join(sandbox.agentDir, 'enhanced-approval-v1', 'sessions');
  let requestPath;
  let envelope;
  for (const sessionDir of await readdir(root)) {
    const directory = join(root, sessionDir);
    const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
    if (owner.sessionId !== parent.sessionId) continue;
    const inbox = join(directory, `inbox-${owner.instanceId}`);
    const name = (await readdir(inbox)).find(value => value.endsWith('.request.json'));
    assert.ok(name, 'the real process transport contains the pending human request');
    requestPath = join(inbox, name);
    envelope = JSON.parse(await readFile(requestPath, 'utf8'));
  }
  assert.ok(envelope);
  await writeFile(requestPath.replace('.request.json', '.response.json'), JSON.stringify({
    version: 1, id: randomUUID(), targetSessionId: parent.sessionId, targetInstanceId: envelope.targetInstanceId,
    route: envelope.route, digest: envelope.digest, approved: true,
  }), { mode: 0o600 });
  assert.equal(await result, false);
  answer.resolve('yes');
});

test('a receiving process parent raw veto blocks before UI using the runtime child principal', { timeout: 15000 }, async (t) => {
  const sandbox = await brokerSandbox(t);
  const seen = [];
  const parent = await brokerSession(t, sandbox, { veto: request => { seen.push(request); return 'Parent deny'; } });
  const child = await brokerProcess(t, sandbox, parent.sessionId);
  assert.equal(await child.authorize(dangerousRequest('rm denied.csv', 'privileged-main')), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agentName, 'worker');
  assert.deepEqual(seen[0].policyChecks, [{ surface: 'bash', matchValues: ['rm denied.csv'] }]);
  assert.equal(parent.prompts.length, 0);
});

test('a failed adapter veto disables readiness without exposing an ordinary approval', async (t) => {
  const sandbox = await brokerSandbox(t);
  const session = await brokerSession(t, sandbox, { veto: async () => { throw new Error('Policy unavailable'); } });
  assert.equal(session.ready(), true);
  assert.equal(await session.authorize(dangerousRequest()), false);
  assert.equal(session.ready(), false);
  assert.equal(session.prompts.length, 0);
});

test('requester shutdown cancels its parent input and does not authorize the abandoned call', async (t) => {
  const sandbox = await brokerSandbox(t);
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  let inputSignal;
  const parent = await brokerSession(t, sandbox, { answer: (_title, _placeholder, options) => {
    inputSignal = options.signal;
    entered.resolve();
    return answer.promise;
  } });
  const child = await brokerSession(t, sandbox, { subagent: true, parent: parent.sessionId });
  const result = child.authorize(dangerousRequest());
  await entered.promise;
  await child.shutdown();
  assert.equal(await result, false);
  assert.equal(inputSignal.aborted, true);
  assert.equal(child.ready(), false);
  answer.resolve('yes');
});

test('changing the registered parent while input is pending cannot reuse that parent approval', async (t) => {
  const sandbox = await brokerSandbox(t);
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  const parent = await brokerSession(t, sandbox, { answer: () => { entered.resolve(); return answer.promise; } });
  let parentId = parent.sessionId;
  const child = await brokerSession(t, sandbox, { subagent: true, parent: () => parentId });
  const result = child.authorize(dangerousRequest());
  await entered.promise;
  parentId = 'different-parent';
  answer.resolve('yes');
  assert.equal(await result, false);
});

test('stale disposed Pi contexts return false instead of leaking lifecycle errors', async (t) => {
  const sandbox = await brokerSandbox(t);
  const session = await brokerSession(t, sandbox);
  const ctx = session.context;
  await session.shutdown();
  session.session.dispose();
  assert.equal(session.state.broker.isEnhancedAdapterReady(ctx), false);
  assert.equal(await session.state.broker.authorizeEnhancedApproval(ctx, dangerousRequest()), false);
});

test('changing a real process request while the user is deciding invalidates the response', { timeout: 15000 }, async (t) => {
  const sandbox = await brokerSandbox(t);
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  t.after(() => answer.resolve('yes'));
  const parent = await brokerSession(t, sandbox, { answer: () => { entered.resolve(); return answer.promise; } });
  const child = await brokerProcess(t, sandbox, parent.sessionId);
  const result = child.authorize(dangerousRequest('rm original.csv'));
  await entered.promise;
  const root = join(sandbox.agentDir, 'enhanced-approval-v1', 'sessions');
  let changed = false;
  for (const sessionDir of await readdir(root)) {
    const directory = join(root, sessionDir);
    const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
    if (owner.sessionId !== parent.sessionId) continue;
    const inbox = join(directory, `inbox-${owner.instanceId}`);
    const name = (await readdir(inbox)).find(value => value.endsWith('.request.json'));
    assert.ok(name);
    const path = join(inbox, name);
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    envelope.request.command = 'rm changed.csv';
    await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });
    changed = true;
  }
  assert.equal(changed, true);
  answer.resolve('yes');
  assert.equal(await result, false);
});
