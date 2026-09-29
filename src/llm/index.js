// Provider registry used by the UI.
import * as gemini from './gemini.js';
import * as openai from './openai.js';

export const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    modelSetting: 'model',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'Stored only on this phone and sent only to Google. Leave empty to use the key on your own server instead.',
    client: gemini,
  },
  openai: {
    label: 'OpenAI',
    modelSetting: 'openaiModel',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Stored only on this phone and sent only to OpenAI. API usage is billed separately from a ChatGPT subscription.',
    client: openai,
  },
};

export const providerOf = (id) => PROVIDERS[id] ?? PROVIDERS.gemini;

/** @param {{provider: string, apiKey: string, model: string, effort: string, systemInstruction: string, contents: Array, signal?: AbortSignal}} opts */
export const generateWod = ({ provider, ...opts }) => providerOf(provider).client.generate(opts);

export const testApiKey = (provider, apiKey, model) => providerOf(provider).client.testKey(apiKey, model);
