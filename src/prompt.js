// Prompt construction, response schema, and response normalization.
import defaultGem from '../gemini_gem.md?raw';

export const DEFAULT_SYSTEM_INSTRUCTIONS = defaultGem.trim();

export const WORKOUT_TYPES = ['AMRAP', 'EMOM', 'For Time', 'TABATA'];

const MOVEMENT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    reps_or_time: { type: 'STRING' },
    weight_rx: { type: 'STRING' },
  },
  required: ['name', 'reps_or_time', 'weight_rx'],
  propertyOrdering: ['name', 'reps_or_time', 'weight_rx'],
};

export const MAX_PARTS = 3;

const PART_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    workout_type: { type: 'STRING', enum: WORKOUT_TYPES },
    time_cap_minutes: { type: 'INTEGER' },
    rounds: { type: 'INTEGER' },
    movements: { type: 'ARRAY', items: MOVEMENT_SCHEMA },
  },
  required: ['workout_type', 'time_cap_minutes', 'movements'],
  propertyOrdering: ['title', 'workout_type', 'time_cap_minutes', 'rounds', 'movements'],
};

// Each part keeps the original single-WOD fields (workout_type, time_cap_minutes,
// movements). "finisher" carries the Tabata core finisher the Gem requires.
export const WOD_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    parts: { type: 'ARRAY', items: PART_SCHEMA, minItems: 1, maxItems: MAX_PARTS },
    finisher: PART_SCHEMA,
    story_version: { type: 'STRING' },
  },
  required: ['parts', 'story_version'],
  propertyOrdering: ['title', 'parts', 'finisher', 'story_version'],
};

const OUTPUT_CONTRACT = `
# App Output Contract (takes priority over any formatting rules above)
You are answering inside a WOD timer app that parses your reply directly into a timer.
Reply with ONE JSON object and nothing else (no markdown fences), in exactly this structure:

{
  "title": "Short catchy WOD name",
  "parts": [
    {
      "title": "Short part name",
      "workout_type": "EMOM",
      "time_cap_minutes": 10,
      "movements": [ { "name": "Dumbbell Thrusters", "reps_or_time": "12", "weight_rx": "2 x 15 kg" } ]
    },
    {
      "title": "Short part name",
      "workout_type": "For Time",
      "time_cap_minutes": 12,
      "rounds": 3,
      "movements": [ { "name": "Run", "reps_or_time": "400 m", "weight_rx": "Bodyweight" } ]
    }
  ],
  "finisher": {
    "workout_type": "TABATA",
    "time_cap_minutes": 4,
    "movements": [ { "name": "Hollow Rocks", "reps_or_time": "20 sec", "weight_rx": "Bodyweight" } ]
  },
  "story_version": "..."
}

Field rules:
- "parts" is the main work in the order it is performed. Use EXACTLY the number of parts the athlete asks for (1 to ${MAX_PARTS}), each with the format requested for that position. Every part is timed on its own; the app adds a short rest between parts, so don't program that rest.
- For every part:
  - "workout_type" is exactly one of "AMRAP", "EMOM", "For Time", "TABATA".
  - "time_cap_minutes" is a whole number: AMRAP/EMOM = its duration, For Time = the time cap, TABATA = 4 per 8-round block.
  - "rounds": For Time only, how many times the full list is performed (1 for a chipper).
  - "movements" is the ordered list for that part:
    - EMOM: one movement per minute, rotating in list order (minute 1 = first item, minute 2 = second, ...).
    - AMRAP: the athlete cycles the list for as many rounds as possible.
    - TABATA: 20 s work / 10 s rest x 8 rounds, rotating through the list.
- "reps_or_time" is a short value only, e.g. "15", "12/side", "400 m", "45 sec", "max". No sentences.
- "weight_rx" is short, e.g. "2 x 22.5 kg", "24 kg", "60 cm box", "Bodyweight".
- In multi-part WODs, give the parts distinct purposes (e.g. strength then engine) and avoid repeating the same movement in consecutive parts.
- The Tabata core finisher goes in "finisher" (workout_type "TABATA", time_cap_minutes 4) and never inside "parts". Omit "finisher" only when the athlete asks to skip it.
- "story_version" is the full coaching text as plain text with light markdown (## headings, - bullets, **bold**). It must include: the intent of the session, a short warm-up, then for EACH part its pacing strategy plus movement standards and a scaling option for every movement, notes for the finisher, safety cues, then a "## Mobile Version" section with a concise summary, and it must end with exactly one follow-up question.
- Use metric units (kg, m, km).
`.trim();

/** "EMOM 10′ + AMRAP 12′" */
export const describeParts = (wod) => wod.parts.map((p) => `${p.workout_type} ${p.time_cap_minutes}′`).join(' + ');

export function buildSystemInstruction(settings) {
  const base = (settings.systemInstructions ?? DEFAULT_SYSTEM_INSTRUCTIONS).trim();
  const equipment = settings.equipment.length
    ? settings.equipment.map((e) => `- ${e}`).join('\n')
    : '- Bodyweight only';
  return `${base}\n\n# Available Equipment (current list; overrides any equipment mentioned above)\n${equipment}\n\n${OUTPUT_CONTRACT}`;
}

function describeHistory(history, limit) {
  const done = history.filter((h) => h.completed).slice(0, limit);
  if (!done.length) return 'No logged workouts yet.';
  return done
    .map((h, i) => {
      const w = h.wod;
      const date = new Date(h.completed.at).toISOString().slice(0, 10);
      const focus = h.prefs?.focus?.length ? h.prefs.focus.join(', ') : "coach's choice";
      const moves = w.parts.flatMap((p) => p.movements.map((m) => m.name)).join(', ');
      const results = (h.completed.results ?? []).map((r) => `${r.label}: ${r.text}`).join('; ');
      const note = h.completed.note ? ` | athlete note: "${h.completed.note}"` : '';
      return `${i + 1}. ${date} | "${w.title ?? 'WOD'}" | ${describeParts(w)} | focus: ${focus} | movements: ${moves} | result: ${results || 'done'}${note}`;
    })
    .join('\n');
}

export function buildGenerationPrompt(prefs, history, settings) {
  const focus = prefs.focus.length
    ? prefs.focus.join(', ')
    : "Coach's choice. Pick what is most needed given the recent history below.";
  const count = Math.min(MAX_PARTS, Math.max(1, Number(prefs.partCount) || 1));
  const formats = Array.from({ length: count }, (_, i) => prefs.styles?.[i] || '');
  const lines = [
    "Program today's WOD.",
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    count === 1
      ? `- Main work length: ${prefs.duration} minutes`
      : `- Main work length: about ${prefs.duration} minutes in total, split across the parts (rest between parts not included)`,
    `- Muscle focus: ${focus}`,
  ];
  if (count === 1) {
    lines.push(`- Structure: a single part ("parts" has 1 entry). Format: ${formats[0] || "coach's choice (prefer EMOM or AMRAP)"}`);
  } else {
    lines.push(`- Structure: a ${count}-part WOD ("parts" has exactly ${count} entries, in this order):`);
    formats.forEach((f, i) => lines.push(`  - Part ${i + 1}: ${f || "coach's choice (pick a format that complements the other parts)"}`));
  }
  lines.push(
    `- Core finisher: ${prefs.finisher ? 'include the Tabata core finisher (4 min)' : 'skip the finisher today; omit the "finisher" field'}`,
  );
  if (prefs.notes.trim()) lines.push(`- Athlete notes: ${prefs.notes.trim()}`);
  lines.push(
    '',
    'Recent training history (most recent first). Avoid repeating the same primary focus and signature movements back to back, and use the results/notes to progress or scale loads:',
    describeHistory(history, settings.historyInPrompt),
  );
  return lines.join('\n');
}

export function buildFeedbackPrompt(feedback) {
  return [
    `Athlete feedback on this WOD: "${feedback.trim()}"`,
    'Revise the workout to address the feedback. Keep everything else the same unless the feedback requires a change.',
    'Update story_version so it matches the revised workout. Return the complete updated JSON object.',
  ].join('\n');
}

// ---------- normalization ----------

const TYPE_ALIASES = {
  amrap: 'AMRAP',
  emom: 'EMOM',
  'for time': 'For Time',
  fortime: 'For Time',
  rft: 'For Time',
  tabata: 'TABATA',
};

function normType(t) {
  const key = String(t ?? '').trim().toLowerCase();
  return TYPE_ALIASES[key] ?? TYPE_ALIASES[key.replace(/[^a-z ]/g, '')] ?? null;
}

function normMovements(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && m.name)
    .map((m) => ({
      name: String(m.name).trim(),
      reps_or_time: String(m.reps_or_time ?? '').trim(),
      weight_rx: String(m.weight_rx ?? '').trim(),
    }));
}

function positiveInt(v, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normPart(raw, label) {
  const workout_type = normType(raw?.workout_type);
  if (!workout_type) throw new Error(`${label}: unknown workout_type "${raw?.workout_type}".`);
  const movements = normMovements(raw.movements);
  if (!movements.length) throw new Error(`${label} has no movements.`);
  const part = {
    title: String(raw.title ?? '').trim(),
    workout_type,
    time_cap_minutes: positiveInt(raw.time_cap_minutes, workout_type === 'TABATA' ? 4 : 20),
    movements,
  };
  if (workout_type === 'For Time') part.rounds = positiveInt(raw.rounds, 1);
  return part;
}

/** Validates a model reply (or a saved WOD, including the older single-part shape). */
export function normalizeWod(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Response was not a JSON object.');

  const legacy = !Array.isArray(raw.parts) || !raw.parts.length;
  const rawParts = legacy ? [{ ...raw, title: '' }] : raw.parts.slice(0, MAX_PARTS);
  const parts = rawParts.map((p, i) => normPart(p, rawParts.length > 1 ? `Part ${i + 1}` : 'Workout'));

  const wod = {
    title: String(raw.title ?? '').trim(),
    parts,
    story_version: String(raw.story_version ?? '').trim(),
  };
  if (!wod.title) wod.title = describeParts(wod);

  if (raw.finisher) {
    try {
      wod.finisher = normPart({ workout_type: 'TABATA', ...raw.finisher }, 'Finisher');
    } catch {
      /* a broken finisher shouldn't sink the whole workout */
    }
  }
  return wod;
}
