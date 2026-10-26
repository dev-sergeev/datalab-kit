import { createProvider } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimpleGigaChat } from './gigachat-stream.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default async function registerDataLab(pi: ExtensionAPI): Promise<void> {
  const baseUrl = process.env.GIGACHAT_API_URL?.trim();
  const apiKey = process.env.JPY_API_TOKEN?.trim();
  if (!baseUrl || !apiKey) return;

  const models: Model<'gigachat-extension-api'>[] = [
    { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 200000, maxTokens: 64000 },
    { id: 'Qwen3.5-397b', name: 'Qwen 3.5 397B', contextWindow: 262144, maxTokens: 32768 },
  ].map(model => ({
    ...model,
    provider: 'DataLab',
    api: 'gigachat-extension-api',
    baseUrl,
    input: ['text'],
    reasoning: true,
    thinkingLevelMap: { off: 'off', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    // Unknown USD prices; zero is not a free-tier claim.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  const stream: typeof streamSimpleGigaChat = (model, context, options = {}) =>
    streamSimpleGigaChat(model, context, {
      ...options,
      apiKey,
      // A saved credential or legacy GigaChat env must not redirect DataLab.
      env: { ...options.env, GIGACHAT_BASE_URL: baseUrl },
    });
  pi.registerProvider(createProvider({
    id: 'DataLab',
    name: 'DataLab',
    models,
    auth: {
      apiKey: {
        name: 'JPY_API_TOKEN',
        async resolve({ signal }) {
          signal.throwIfAborted();
          return { auth: { apiKey, baseUrl }, source: 'JPY_API_TOKEN' };
        },
      },
    },
    api: { stream, streamSimple: stream },
  }));
}
