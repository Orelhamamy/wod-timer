// Plumbing shared by the AI providers: requests, timeouts, errors, JSON parsing.
import { normalizeWod } from '../prompt.js';

const TIMEOUT_MS = 180_000; // extended thinking can take a while

function withTimeout(signal) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : null;
  if (signal && timeout && AbortSignal.any) return AbortSignal.any([signal, timeout]);
  return signal ?? timeout ?? undefined;
}

/**
 * POSTs JSON and returns the parsed response body, or throws a readable error.
 * @param {string} url
 * @param {{label: string, headers?: object, body: object, signal?: AbortSignal, noJsonError?: string}} opts
 *   noJsonError: message to use when the server answers with a non-JSON error (e.g. a static host's 404 page)
 */
export async function postJson(url, { label, headers = {}, body, signal, noJsonError }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: withTimeout(signal),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request cancelled.');
    if (err.name === 'TimeoutError') throw new Error('The coach took too long to answer. Try again.');
    throw new Error(navigator.onLine ? `Network error: ${err.message}` : 'You are offline. Generating a WOD needs a connection.');
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (!data && noJsonError) throw new Error(noJsonError);
    throw new Error(`${label} API error: ${data?.error?.message ?? `HTTP ${res.status}`}`);
  }
  if (!data) throw new Error(`${label} returned an unreadable response.`);
  return data;
}

/** GET used by the "Test" button. */
export async function getJson(url, headers) {
  const res = await fetch(url, { headers }).catch(() => {
    throw new Error(navigator.onLine ? 'Could not reach the API.' : 'You are offline.');
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
  return data;
}

/** Parses the model's text into a validated WOD. */
export function parseWodText(text) {
  const trimmed = text.trim();
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // Fall back to the outermost {...} in case the model wrapped it in fences.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    try {
      raw = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new Error('The coach replied with invalid JSON. Try again.');
    }
  }
  return normalizeWod(raw);
}
