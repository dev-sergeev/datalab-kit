import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { isolateGigaChatEnv, startKit } from './helpers/kit-session.mjs';

const userModel = {
  id: 'user-model', name: 'User model', provider: 'user-provider', api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1/user-api', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};

async function localApi(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'Local DataLab response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, url: `http://127.0.0.1:${server.address().port}/tenant/api/v1` };
}

async function optionalFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertUserSelection(session, agentDir, original) {
  assert.equal(session.model?.provider, 'user-provider');
  assert.equal(session.model?.id, 'user-model');
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')), original);
}

for (const [label, urlValue, token] of [
  ['both variables are missing', undefined, undefined],
  ['the URL is missing', undefined, 'fixture-token'],
  ['the token is missing', 'fixture-url', undefined],
  ['the URL is empty', '', 'fixture-token'],
  ['the token is empty', 'fixture-url', ''],
  ['the URL is whitespace', ' \t ', 'fixture-token'],
  ['the token is whitespace', 'fixture-url', ' \t '],
]) {
  test(`DataLab is absent when ${label}`, async t => {
    const api = await localApi(t);
    isolateGigaChatEnv(t, {
      GIGACHAT_API_URL: urlValue === 'fixture-url' ? api.url : urlValue,
      JPY_API_TOKEN: token,
    });
    const { session, extensionsResult, agentDir, original } = await startKit(t, undefined, { model: userModel });
    assert.deepEqual(extensionsResult.errors, []);
    await session.bindExtensions({ mode: 'rpc' });
    assert.equal(session.modelRuntime.getProvider('DataLab'), undefined);
    assert.deepEqual(session.modelRuntime.getModels('DataLab'), []);
    assert.equal((await session.modelRuntime.getAvailable()).some(model => model.provider === 'DataLab'), false);
    await assertUserSelection(session, agentDir, original);
    assert.deepEqual(api.requests, [], 'loading and listing models must not probe the API');
  });
}

test('DataLab models use the trimmed environment connection without selecting a model or saving credentials', async t => {
  const api = await localApi(t);
  const legacy = await localApi(t);
  const token = 'datalab-private-fixture-token';
  const legacyToken = 'legacy-private-fixture-token';
  isolateGigaChatEnv(t, {
    GIGACHAT_API_URL: ` ${api.url}/ `,
    JPY_API_TOKEN: ` \t${token}\n`,
    GIGACHAT_BASE_URL: legacy.url,
    GIGACHAT_ACCESS_TOKEN: legacyToken,
    GIGACHAT_STREAM: 'false', GIGACHAT_MAX_RETRIES: '0',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined,
    http_proxy: undefined, https_proxy: undefined, all_proxy: undefined,
  });
  const { session, extensionsResult, agentDir, original } = await startKit(t, undefined, { model: userModel });
  assert.deepEqual(extensionsResult.errors, []);
  await session.bindExtensions({ mode: 'rpc' });
  const models = session.modelRuntime.getModels('DataLab');
  assert.deepEqual(models.map(model => model.id).sort(), ['Qwen3.5-397b', 'glm-5.2']);
  assert.deepEqual((await session.modelRuntime.getAvailable('DataLab')).map(model => model.id).sort(),
    ['Qwen3.5-397b', 'glm-5.2']);
  await assertUserSelection(session, agentDir, original);
  assert.deepEqual(api.requests, [], 'registration and model listing must not make a network probe');

  for (const [id, contextWindow, maxTokens] of [['glm-5.2', 200000, 64000], ['Qwen3.5-397b', 262144, 32768]]) {
    const model = session.modelRuntime.getModel('DataLab', id);
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.maxTokens, maxTokens);
    const response = await session.modelRuntime.completeSimple(model, {
      messages: [{ role: 'user', content: 'Answer using the local fixture.', timestamp: 1 }],
    });
    assert.equal(response.stopReason, 'stop', response.errorMessage);
    assert.equal(response.content.find(block => block.type === 'text')?.text, 'Local DataLab response');
    assert.equal(api.requests.at(-1).path, '/tenant/api/v1/chat/completions');
    assert.equal(api.requests.at(-1).authorization, `Bearer ${token}`);
    assert.equal(api.requests.at(-1).body.model, id);
    assert.equal(api.requests.at(-1).body.max_tokens, maxTokens);
  }
  assert.equal(api.requests.length, 2);
  assert.deepEqual(legacy.requests, [], 'ambient legacy connection settings must not redirect DataLab');
  await session.reload();
  await assertUserSelection(session, agentDir, original);
  assert.equal(api.requests.length, 2, 'reload must not probe the API');
  assert.deepEqual(legacy.requests, []);
  for (const name of ['settings.json', 'models.json', 'auth.json']) {
    const contents = await optionalFile(join(agentDir, name));
    assert.equal(contents?.includes(token) ?? false, false, `${name} must not persist the environment token`);
    assert.equal(contents?.includes(legacyToken) ?? false, false, `${name} must not persist the legacy token`);
  }
});
