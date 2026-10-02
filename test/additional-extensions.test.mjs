import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createAgentSession, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { agentSandbox } from './helpers/agent-sandbox.mjs';
import { startKit } from './helpers/kit-session.mjs';

async function startAdditional(t, { recapConfig, skill } = {}) {
  const { cwd, agentDir, trackSession } = await agentSandbox(t);
  const original = { packages: [resolve('.')], defaultProvider: 'user-provider', defaultModel: 'user-model' };
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(original));
  const recapPath = join(agentDir, 'extensions', 'pi-recap.json');
  if (recapConfig !== undefined) {
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(recapPath, typeof recapConfig === 'string' ? recapConfig : JSON.stringify(recapConfig));
  }
  if (skill) {
    const folder = join(cwd, '.pi', 'skills', 'kit-skill');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), skill);
  }
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: Boolean(skill) });
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
  });
  trackSession(session);
  assert.deepEqual(extensionsResult.errors, []);
  return { session, extensionsResult, cwd, agentDir, recapPath, original };
}

async function localGigaChat(t) {
  const requests = [];
  const recap = 'Adding four Pi extensions. Defaults preserve user settings; verify the integration.';
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: recap }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const changes = { GIGACHAT_ACCESS_TOKEN: 'local-fixture-token',
    GIGACHAT_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, GIGACHAT_STREAM: 'false',
    GIGACHAT_EXTRA_BODY: '{}', GIGACHAT_REASONING_IN_CONTENT: 'false', GIGACHAT_MAX_RETRIES: '0',
    GIGACHAT_SYSTEM_PROMPT: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  };
  const names = new Set([...Object.keys(process.env).filter(name => name.startsWith('GIGACHAT_')),
    ...Object.keys(changes), 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']);
  const previous = Object.fromEntries([...names].map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, changes);
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await new Promise(resolve => server.close(resolve));
  });
  return { requests, recap };
}

test('the twelve kit components load together in Pi 0.85.1 without changing the selected session model', async t => {
  const { session, extensionsResult, agentDir, original } = await startKit(t);
  assert.deepEqual(extensionsResult.errors, []);
  assert.equal(extensionsResult.extensions.length, 12);
  await session.bindExtensions({ mode: 'rpc' });
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')), original);
});

test('recap starts with Qwen while preserving the selected session model', async t => {
  const { session, recapPath, agentDir, original } = await startAdditional(t);
  await session.bindExtensions({ mode: 'rpc' });
  assert.equal(JSON.parse(await readFile(recapPath, 'utf8')).model, 'gigachat/Qwen3.5-397b');
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')), original);
});

test('an existing recap config without a model gets the default and retains unrelated preferences', async t => {
  const original = { userSetting: { keep: true } };
  const { session, recapPath } = await startAdditional(t, { recapConfig: original });
  await session.bindExtensions({ mode: 'rpc' });
  assert.deepEqual(JSON.parse(await readFile(recapPath, 'utf8')), { ...original, model: 'gigachat/Qwen3.5-397b' });
});

for (const config of ['{invalid JSON', '{"model":42,"userSetting":true}', '{"model":"bad-model","userSetting":true}']) {
  test(`an invalid explicit recap config is not overwritten: ${config}`, async t => {
    const { session, recapPath } = await startAdditional(t, { recapConfig: config });
    await session.bindExtensions({ mode: 'rpc' });
    await session.reload();
    assert.equal(await readFile(recapPath, 'utf8'), config);
  });
}

for (const model of [undefined, 'gigachat/glm-5.2']) {
  test(`recap generates with ${model ?? 'the Qwen default'} and keeps the user preference after reload`, async t => {
    const { requests, recap } = await localGigaChat(t);
    const config = model === undefined ? undefined : { model, userSetting: { keep: true } };
    const { session, recapPath } = await startAdditional(t, { recapConfig: config });
    const notices = [];
    const widgets = new Map();
    await session.bindExtensions({ mode: 'rpc', uiContext: { ...session.extensionRunner.getUIContext(),
      notify: (...notice) => notices.push(notice),
      setWidget: (name, widget) => widgets.set(name, widget),
    } });
    const mainModel = session.modelRuntime.getModel('gigachat', 'glm-5.2');
    assert.ok(mainModel);
    await session.setModel(mainModel);
    session.setThinkingLevel('high');
    session.sessionManager.appendMessage({ role: 'user', content: 'Add four extensions and preserve user settings.', timestamp: 1 });
    await session.prompt('/recap');
    assert.equal(requests.length, 1, JSON.stringify(notices));
    assert.equal(requests[0].path, '/v1/chat/completions');
    assert.equal(requests[0].authorization, 'Bearer local-fixture-token');
    assert.equal(requests[0].body.model, model === undefined ? 'Qwen3.5-397b' : 'glm-5.2');
    if (model === undefined) assert.equal(requests[0].body.reasoning_effort, 'off');
    assert.match(requests[0].body.messages.at(-1).content, /preserve user settings/);
    const widget = widgets.get('pi-recap');
    assert.equal(typeof widget, 'function', JSON.stringify(notices));
    const theme = { fg: (_color, text) => text, bold: text => text };
    assert.match(widget({}, theme).render(200).join('\n'), new RegExp(recap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(session.model.id, 'glm-5.2');
    assert.equal(session.thinkingLevel, 'high');
    const beforeReload = await readFile(recapPath, 'utf8');
    if (config) assert.deepEqual(JSON.parse(beforeReload), config);
    await session.reload();
    assert.equal(await readFile(recapPath, 'utf8'), beforeReload);
    await session.prompt('/recap status');
    assert.match(notices.at(-1)[0], new RegExp(`selected model: ${model ?? 'gigachat/Qwen3.5-397b'}`));
  });
}

test('resetting the recap picker to Use default immediately selects Qwen without reloading', async t => {
  const { requests } = await localGigaChat(t);
  const { session } = await startAdditional(t, { recapConfig: { model: 'gigachat/glm-5.2' } });
  const notices = [];
  const theme = { fg: (_color, text) => text, bold: text => text };
  await session.bindExtensions({ mode: 'rpc', uiContext: { ...session.extensionRunner.getUIContext(),
    notify: (...notice) => notices.push(notice),
    custom: async factory => {
      let selection;
      const component = await factory({ requestRender() {} }, theme, {}, result => { selection = result; });
      assert.match(component.render(100).join('\n'), /→ Use default/);
      component.handleInput('\r');
      assert.ok(selection, 'Enter selects the highlighted default row');
      return selection;
    },
  } });
  await session.setModel(session.modelRuntime.getModel('gigachat', 'glm-5.2'));
  await session.prompt('/recap config');
  await session.prompt('/recap status');
  assert.match(notices.at(-1)[0], /selected model: gigachat\/Qwen3\.5-397b \(default\)/);
  session.sessionManager.appendMessage({ role: 'user', content: 'Verify the recap default in the current session.', timestamp: 1 });
  await session.prompt('/recap');
  assert.equal(requests.length, 1, JSON.stringify(notices));
  assert.equal(requests[0].body.model, 'Qwen3.5-397b');
  assert.equal(requests[0].body.reasoning_effort, 'off');
  assert.equal(session.model.id, 'glm-5.2');
});

test('elapsed counts the full TUI run across tool turns and restores the working indicator at the end', async t => {
  const { session } = await startAdditional(t);
  const working = [];
  const errors = [];
  await session.bindExtensions({ mode: 'tui', uiContext: { ...session.extensionRunner.getUIContext(),
    setWorkingMessage: message => working.push(message),
  } });
  const runner = session.extensionRunner;
  runner.onError(error => errors.push(error));
  await runner.emit({ type: 'agent_start' });
  assert.equal(working.at(-1), 'Working... 0s');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.match(working.at(-1), /^Working\.\.\. [1-9]\d*s$/);
  await runner.emit({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
  await runner.emit({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'local-read', args: { path: 'local.txt' } });
  await runner.emit({ type: 'tool_execution_end', toolName: 'read', toolCallId: 'local-read',
    result: { content: [{ type: 'text', text: 'local fixture' }] }, isError: false });
  await runner.emit({ type: 'turn_end', turnIndex: 0,
    message: { role: 'user', content: 'local fixture', timestamp: Date.now() }, toolResults: [] });
  await runner.emit({ type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(Number(working.at(-1).match(/(\d+)s$/)?.[1]) >= 2, 'the second turn keeps time from the same run');
  assert.equal(working.includes(undefined), false, 'tool completion must not clear the full-run timer');
  await runner.emit({ type: 'agent_end', messages: [] });
  assert.equal(working.at(-1), undefined);
  const completed = working.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(working.length, completed, 'the completed run must not keep ticking');
  await runner.emit({ type: 'agent_start' });
  assert.equal(working.at(-1), 'Working... 0s');
  await runner.emit({ type: 'session_shutdown', reason: 'exit' });
  assert.equal(working.at(-1), undefined);
  assert.deepEqual(errors, []);
});

test('elapsed stays idle outside TUI mode', async t => {
  const { session } = await startAdditional(t);
  const working = [];
  await session.bindExtensions({ mode: 'rpc', uiContext: { ...session.extensionRunner.getUIContext(),
    setWorkingMessage: message => working.push(message),
  } });
  await session.extensionRunner.emit({ type: 'agent_start' });
  await session.extensionRunner.emit({ type: 'agent_end', messages: [] });
  assert.deepEqual(working.filter(message => message !== undefined), []);
});

test('a skill hidden by the stock toggle UI remains selectable and manually usable through $ after reload', async t => {
  const { requests } = await localGigaChat(t);
  const skill = '---\nname: kit-skill\ndescription: Offline kit integration skill\n---\nUse the local fixture instructions.\n';
  const { session, cwd } = await startAdditional(t, { skill });
  const notices = [];
  const errors = [];
  const baseAutocomplete = () => new CombinedAutocompleteProvider([
    { name: 'skill:kit-skill', description: 'Offline kit integration skill' },
    { name: 'recap', description: 'Generate recap' },
  ], cwd);
  let autocomplete = baseAutocomplete();
  await session.bindExtensions({ mode: 'rpc', uiContext: { ...session.extensionRunner.getUIContext(),
    notify: (...notice) => notices.push(notice),
    select: async (_title, options) => {
      assert.ok(options.includes('kit-skill: enabled'));
      return 'kit-skill: enabled';
    },
    addAutocompleteProvider: factory => { autocomplete = factory(autocomplete); },
  } });
  session.extensionRunner.onError(error => errors.push(error));
  assert.match(session.systemPrompt, /<name>kit-skill<\/name>/);
  await session.prompt('/toggle-skills');
  assert.match(await readFile(join(cwd, '.pi/skills/kit-skill/SKILL.md'), 'utf8'), /disable-model-invocation: true/);
  assert.match(session.systemPrompt, /<name>kit-skill<\/name>/, 'stock toggle applies after reload');
  await session.reload({ beforeSessionStart: () => { autocomplete = baseAutocomplete(); } });
  session.extensionRunner.onError(error => errors.push(error));
  assert.doesNotMatch(session.systemPrompt, /<name>kit-skill<\/name>/);
  const signal = new AbortController().signal;
  const slash = await autocomplete.getSuggestions(['/'], 0, 1, { signal });
  assert.ok(slash?.items.some(item => item.value === 'recap'));
  assert.equal(slash?.items.some(item => item.value === 'skill:kit-skill'), false);
  const dollar = await autocomplete.getSuggestions(['$kit-'], 0, 5, { signal });
  assert.ok(dollar?.items.some(item => item.label === 'kit-skill'), JSON.stringify(dollar));
  await session.setModel(session.modelRuntime.getModel('gigachat', 'Qwen3.5-397b'));
  await session.prompt('Apply $kit-skill to this task.');
  assert.equal(requests.length, 1, JSON.stringify(notices));
  const content = requests[0].body.messages.find(message => message.role === 'user').content;
  assert.match(content, /<skill name="kit-skill"/);
  assert.match(content, /Use the local fixture instructions\./);
  assert.doesNotMatch(content, /Apply \$kit-skill/);
  assert.deepEqual(errors, []);
});
