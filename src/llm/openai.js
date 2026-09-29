// OpenAI (Responses API) with strict structured outputs.
// The key saved on the device is sent straight to api.openai.com.
import { WOD_RESPONSE_SCHEMA } from '../prompt.js';
import { postJson, getJson, parseWodText } from './common.js';

const OPENAI_API = 'https://api.openai.com/v1';

/**
 * Converts the Gemini-style schema to the JSON Schema that OpenAI's strict mode
 * accepts: every property is listed in "required", optional ones become nullable,
 * and objects don't allow extra keys.
 */
function toStrictSchema(schema, optional = false) {
  let out;
  if (schema.type === 'OBJECT') {
    const keys = Object.keys(schema.properties);
    out = {
      type: 'object',
      properties: Object.fromEntries(keys.map((k) => [k, toStrictSchema(schema.properties[k], !schema.required?.includes(k))])),
      required: keys,
      additionalProperties: false,
    };
  } else if (schema.type === 'ARRAY') {
    out = { type: 'array', items: toStrictSchema(schema.items) };
  } else {
    out = { type: schema.type.toLowerCase() };
    if (schema.enum) out.enum = schema.enum;
  }
  if (!optional) return out;
  return out.type === 'object' || out.type === 'array' ? { anyOf: [out, { type: 'null' }] } : { ...out, type: [out.type, 'null'] };
}

export const OPENAI_WOD_SCHEMA = toStrictSchema(WOD_RESPONSE_SCHEMA);

const authHeader = (apiKey) => ({ Authorization: `Bearer ${apiKey}` });

export async function testKey(apiKey, model) {
  const data = await getJson(`${OPENAI_API}/models/${encodeURIComponent(model)}`, authHeader(apiKey));
  return data.id ?? model;
}

/**
 * Conversations are stored in Gemini's "contents" shape; convert them to Responses API input.
 * @returns {Promise<{wod: object, modelContent: object}>}
 */
export async function generate({ apiKey, model, effort, systemInstruction, contents, signal }) {
  if (!apiKey) throw new Error('No OpenAI API key set. Add it in Settings → AI provider.');

  const body = {
    model,
    instructions: systemInstruction,
    input: contents.map((c) => ({
      role: c.role === 'model' ? 'assistant' : 'user',
      content: c.parts.map((p) => p.text ?? '').join(''),
    })),
    text: { format: { type: 'json_schema', name: 'wod', schema: OPENAI_WOD_SCHEMA, strict: true } },
    store: false,
  };
  if (effort) body.reasoning = { effort };

  const data = await postJson(`${OPENAI_API}/responses`, { label: 'OpenAI', headers: authHeader(apiKey), body, signal });

  if (data.status === 'incomplete') {
    throw new Error(`The response was cut off (${data.incomplete_details?.reason ?? 'incomplete'}). Try a lower thinking effort.`);
  }
  const content = (data.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
  const refusal = content.find((c) => c.type === 'refusal');
  if (refusal) throw new Error(`OpenAI declined: ${refusal.refusal}`);
  const text = content.filter((c) => c.type === 'output_text').map((c) => c.text).join('');
  if (!text) throw new Error('No workout returned.');

  return { wod: parseWodText(text), modelContent: { role: 'model', parts: [{ text }] } };
}
