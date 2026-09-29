// Persistence in localStorage. Everything stays on the device.

const KEYS = {
  settings: 'wod.settings.v1',
  history: 'wod.history.v1',
  currentId: 'wod.currentId.v1',
  prefs: 'wod.prefs.v1',
  apiKeys: { gemini: 'wod.apiKey.v1', openai: 'wod.apiKey.openai.v1' },
};

const MAX_HISTORY = 100;

export const DEFAULT_EQUIPMENT = [
  'Paired dumbbells',
  'Kettlebells',
  'Jump rope',
  'Plyo box',
  'Outdoor space for running',
];

export const DEFAULT_SETTINGS = {
  systemInstructions: null, // null = use gemini_gem.md as shipped
  equipment: DEFAULT_EQUIPMENT,
  provider: 'gemini', // 'gemini' | 'openai'
  model: 'gemini-3.6-flash', // Gemini model
  openaiModel: 'gpt-5-mini',
  thinkingLevel: 'high',
  historyInPrompt: 5,
  beeps: true,
  voice: true,
  prepSeconds: 10,
  transitionSeconds: 60,
};

export const DEFAULT_PREFS = {
  duration: '20',
  focus: [],
  partCount: '1',
  styles: ['', '', ''], // format per part, '' = coach's choice
  finisher: true,
  notes: '',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('Could not save', key, err);
  }
}

export const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) });
export const saveSettings = (settings) => write(KEYS.settings, settings);

export function loadPrefs() {
  const { style, ...stored } = read(KEYS.prefs, {});
  const prefs = { ...DEFAULT_PREFS, ...stored };
  if (style && !stored.styles) prefs.styles = [style, '', '']; // older single-format prefs
  return prefs;
}
export const savePrefs = (prefs) => write(KEYS.prefs, prefs);

export const loadHistory = () => read(KEYS.history, []);
export const saveHistory = (history) => write(KEYS.history, history.slice(0, MAX_HISTORY));

export const loadCurrentId = () => read(KEYS.currentId, null);
export const saveCurrentId = (id) => write(KEYS.currentId, id);

// Kept apart from settings so they never end up in a backup file.
export const loadApiKey = (provider) => read(KEYS.apiKeys[provider], '');
export const saveApiKey = (provider, key) => write(KEYS.apiKeys[provider], key);

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
