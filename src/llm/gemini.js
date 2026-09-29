// Google Gemini (generateContent REST API).
// - With a key saved on the device, requests go straight to Google.
// - Without one, they go to the same-origin /api/gemini proxy (see vite.config.js),
//   which adds the key from .env on the server.
import { WOD_RESPONSE_SCHEMA } from '../prompt.js';
import { postJson, getJson, parseWodText } from './common.js';

const GOOGLE_API = 'https://generativelanguage.googleapis.com';
const PROXY_API = `${import.meta.env.BASE_URL}api/gemini`;

export async function testKey(apiKey, model) {
  const data = await getJson(`${GOOGLE_API}/v1beta/models/${encodeURIComponent(model)}`, { 'x-goog-api-key': apiKey });
  return data.displayName ?? model;
}

/** @returns {Promise<{wod: object, modelContent: object}>} */
export async function generate({ apiKey, model, effort, systemInstruction, contents, signal }) {
  const generation_config = {
    response_mime_type: 'application/json',
    response_schema: WOD_RESPONSE_SCHEMA,
  };
  if (effort) generation_config.thinking_config = { thinking_level: effort };

  const path = `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await postJson(apiKey ? GOOGLE_API + path : PROXY_API + path, {
    label: 'Gemini',
    headers: apiKey ? { 'x-goog-api-key': apiKey } : {},
    body: { system_instruction: { parts: [{ text: systemInstruction }] }, contents, generation_config },
    signal,
    noJsonError: apiKey ? undefined : 'No API key set. Add your key in Settings → AI provider.',
  });

  if (data.promptFeedback?.blockReason) throw new Error(`Request blocked: ${data.promptFeedback.blockReason}`);
  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error(`No workout returned${candidate?.finishReason ? ` (${candidate.finishReason})` : ''}.`);
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new Error('The response was cut off (MAX_TOKENS). Try a lower thinking effort.');
  }

  const parts = candidate.content.parts.filter((p) => !p.thought);
  const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
  // Keep the model's content (incl. thought signatures) for multi-turn refinement.
  return { wod: parseWodText(text), modelContent: { role: 'model', parts } };
}
