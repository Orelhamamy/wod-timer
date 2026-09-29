import './style.css';
import { generateWod, testApiKey, providerOf } from './llm/index.js';
import {
  DEFAULT_SYSTEM_INSTRUCTIONS,
  buildSystemInstruction,
  buildGenerationPrompt,
  buildFeedbackPrompt,
  describeParts,
  normalizeWod,
} from './prompt.js';
import {
  loadSettings,
  saveSettings,
  loadPrefs,
  savePrefs,
  loadHistory,
  saveHistory,
  loadCurrentId,
  saveCurrentId,
  loadApiKey,
  saveApiKey,
  newId,
  DEFAULT_SETTINGS,
} from './storage.js';
import { buildPlan, WorkoutTimer, fmtClock, movementText } from './timer.js';
import { unlockAudio, beep, speak, stopSpeech } from './audio.js';
import { escapeHtml as esc, renderMarkdown, formatDate } from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  settings: loadSettings(),
  prefs: loadPrefs(),
  history: loadHistory(),
  currentId: loadCurrentId(),
  apiKeys: { gemini: loadApiKey('gemini'), openai: loadApiKey('openai') },
  busy: null, // AbortController while a request is in flight
};

// WODs saved before multi-part support kept a single piece at the top level.
function upgradeEntry(h) {
  if (!h?.id || !h.wod) return false;
  if (h.wod.parts) return true;
  try {
    h.wod = normalizeWod(h.wod);
    return true;
  } catch {
    return false;
  }
}
state.history = state.history.filter(upgradeEntry);

const currentEntry = () => state.history.find((h) => h.id === state.currentId) ?? null;

function persistHistory() {
  saveHistory(state.history);
  saveCurrentId(state.currentId);
}

// =====================================================================
// Tabs
// =====================================================================

function showView(name) {
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  if (name === 'history') renderHistory();
  window.scrollTo({ top: 0 });
}

$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.tab)));

// =====================================================================
// Generation form
// =====================================================================

function setupChips() {
  $$('#gen-form .chips[data-name]').forEach((group) => {
    const name = group.dataset.name;
    const multi = group.hasAttribute('data-multi');
    const sync = () => {
      const value = state.prefs[name];
      $$('.chip', group).forEach((c) => {
        const on = multi ? value.includes(c.dataset.value) : value === c.dataset.value;
        c.setAttribute('aria-pressed', String(on));
      });
    };
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const v = chip.dataset.value;
      if (multi) {
        const set = new Set(state.prefs[name]);
        set.has(v) ? set.delete(v) : set.add(v);
        state.prefs[name] = [...set];
      } else {
        state.prefs[name] = v;
      }
      savePrefs(state.prefs);
      sync();
      if (name === 'partCount') renderPartFormats();
    });
    sync();
  });
  renderPartFormats();

  const finisher = $('#gen-finisher');
  const notes = $('#gen-notes');
  finisher.checked = state.prefs.finisher;
  notes.value = state.prefs.notes;
  finisher.addEventListener('change', () => {
    state.prefs.finisher = finisher.checked;
    savePrefs(state.prefs);
  });
  notes.addEventListener('input', () => {
    state.prefs.notes = notes.value;
    savePrefs(state.prefs);
  });
}

const FORMAT_OPTIONS = [
  ['', "Coach's choice"],
  ['AMRAP', 'AMRAP'],
  ['EMOM', 'EMOM'],
  ['For Time', 'For Time'],
  ['TABATA', 'Tabata'],
];

/** One format picker per part (Part 1 EMOM, Part 2 AMRAP, ...). */
function renderPartFormats() {
  const count = Number(state.prefs.partCount) || 1;
  $('#part-formats').innerHTML = Array.from(
    { length: count },
    (_, i) => `
    <div class="part-format">
      <div class="part-format-label">${count > 1 ? `Part ${i + 1} format` : 'Format'}</div>
      <div class="chips" data-part="${i}">
        ${FORMAT_OPTIONS.map(
          ([value, label]) =>
            `<button type="button" class="chip" data-value="${esc(value)}" aria-pressed="${(state.prefs.styles[i] ?? '') === value}">${esc(label)}</button>`,
        ).join('')}
      </div>
    </div>`,
  ).join('');
}

$('#part-formats').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const styles = [...state.prefs.styles];
  styles[Number(chip.parentElement.dataset.part)] = chip.dataset.value;
  state.prefs.styles = styles;
  savePrefs(state.prefs);
  renderPartFormats();
});

function showError(msg) {
  const el = $('#gen-error');
  el.textContent = msg ?? '';
  el.hidden = !msg;
}

/** Provider, key, model and effort for the next request. */
function aiOptions() {
  const provider = state.settings.provider;
  return {
    provider,
    apiKey: state.apiKeys[provider] ?? '',
    model: state.settings[providerOf(provider).modelSetting],
    effort: state.settings.thinkingLevel,
  };
}

/** Runs an AI request with a shared busy/cancel state. `button` shows progress. */
async function withBusy(button, idleLabel, fn) {
  if (state.busy) return;
  const controller = new AbortController();
  state.busy = controller;
  showError(null);

  const label = $('.btn-label', button) ?? button;
  const started = Date.now();
  const update = () => {
    label.textContent = `Coach is thinking… ${Math.round((Date.now() - started) / 1000)}s`;
  };
  update();
  const timer = setInterval(update, 1000);
  button.classList.add('loading');
  document.body.classList.add('busy');
  $('#gen-cancel').hidden = false;

  try {
    await fn(controller.signal);
  } catch (err) {
    showError(err.message);
    $('#gen-error').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally {
    clearInterval(timer);
    label.textContent = idleLabel;
    button.classList.remove('loading');
    document.body.classList.remove('busy');
    $('#gen-cancel').hidden = true;
    state.busy = null;
  }
}

$('#gen-cancel').addEventListener('click', () => state.busy?.abort());

$('#gen-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('#gen-btn'), 'Generate WOD', async (signal) => {
    const prefs = structuredClone(state.prefs);
    const userText = buildGenerationPrompt(prefs, state.history, state.settings);
    const contents = [{ role: 'user', parts: [{ text: userText }] }];
    const { wod, modelContent } = await generateWod({
      ...aiOptions(),
      systemInstruction: buildSystemInstruction(state.settings),
      contents,
      signal,
    });
    const entry = {
      id: newId(),
      createdAt: Date.now(),
      prefs,
      wod,
      contents: [...contents, modelContent],
      feedback: [],
      completed: null,
      source: { provider: state.settings.provider, model: aiOptions().model },
    };
    state.history.unshift(entry);
    state.currentId = entry.id;
    persistHistory();
    $('#gen-panel').open = false;
    renderCurrent();
    $('#wod-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

async function refineCurrent(feedback, button) {
  let entry = currentEntry();
  if (!entry || !feedback.trim()) return;
  await withBusy(button, 'Update WOD', async (signal) => {
    const contents = [...entry.contents, { role: 'user', parts: [{ text: buildFeedbackPrompt(feedback) }] }];
    const { wod, modelContent } = await generateWod({
      ...aiOptions(),
      systemInstruction: buildSystemInstruction(state.settings),
      contents,
      signal,
    });
    // A logged workout stays as it was; the revision becomes a new entry.
    if (entry.completed) {
      entry = { ...structuredClone(entry), id: newId(), createdAt: Date.now(), completed: null };
      state.history.unshift(entry);
      state.currentId = entry.id;
    }
    entry.wod = wod;
    entry.contents = [...contents, modelContent];
    entry.source = { provider: state.settings.provider, model: aiOptions().model };
    entry.feedback = [...(entry.feedback ?? []), feedback.trim()];
    persistHistory();
    renderCurrent();
  });
}

// =====================================================================
// WOD dashboard
// =====================================================================

function pieceHint(p) {
  switch (p.workout_type) {
    case 'AMRAP':
      return `As many rounds as possible in ${p.time_cap_minutes} min`;
    case 'EMOM':
      return p.movements.length > 1
        ? `Every minute on the minute for ${p.time_cap_minutes} min, rotating through the list`
        : `Every minute on the minute for ${p.time_cap_minutes} min`;
    case 'For Time':
      return `${p.rounds > 1 ? `${p.rounds} rounds` : 'Complete'} for time, ${p.time_cap_minutes} min cap`;
    case 'TABATA':
      return `${Math.round((p.time_cap_minutes * 60) / 30)} rounds: 20 s work / 10 s rest`;
    default:
      return '';
  }
}

function pieceHtml(p, heading) {
  const badges = [`<span class="badge accent">${esc(p.workout_type)}</span>`, `<span class="badge">${p.time_cap_minutes} min</span>`];
  if (p.workout_type === 'For Time' && p.rounds > 1) badges.push(`<span class="badge">${p.rounds} rounds</span>`);
  return `
    <div class="piece">
      <div class="piece-head">
        ${heading ? `<h3>${esc(heading)}</h3>` : ''}
        <div class="badges">${badges.join('')}</div>
      </div>
      <p class="piece-hint">${esc(pieceHint(p))}</p>
      <ol class="movements">
        ${p.movements
          .map(
            (m) => `
          <li>
            <span class="mv-reps">${esc(m.reps_or_time)}</span>
            <span class="mv-main">
              <span class="mv-name">${esc(m.name)}</span>
              ${m.weight_rx ? `<span class="mv-weight">${esc(m.weight_rx)}</span>` : ''}
            </span>
          </li>`,
          )
          .join('')}
      </ol>
    </div>`;
}

function partsHtml(w) {
  const multi = w.parts.length > 1;
  const rest = state.settings.transitionSeconds;
  const divider = rest > 0 ? `<div class="part-rest">Rest ${fmtClock(rest)}</div>` : '';
  const pieces = w.parts.map((p, i) => pieceHtml(p, multi ? `Part ${i + 1}${p.title ? ` · ${p.title}` : ''}` : ''));
  if (w.finisher) pieces.push(pieceHtml(w.finisher, 'Core Finisher'));
  return pieces.join(divider);
}

const QUICK_FEEDBACK = [
  'Replace the running with burpees',
  'Make it harder',
  'Make it easier',
  'No jumping',
  'Heavier weights',
  'Less equipment changes',
];

function renderCurrent() {
  const entry = currentEntry();
  const box = $('#wod-result');
  $('#wod-empty').hidden = !!entry;
  box.hidden = !entry;
  if (!entry) {
    box.innerHTML = '';
    return;
  }
  const w = entry.wod;
  const focus = entry.prefs?.focus?.length ? entry.prefs.focus.join(' · ') : "Coach's choice";

  box.innerHTML = `
    <article class="card wod-card">
      <div class="wod-meta-line">
        <span>${esc(formatDate(entry.createdAt))}</span>
        <span>${esc(focus)}</span>
        ${w.parts.length > 1 ? `<span>${esc(describeParts(w))}</span>` : ''}
        ${entry.source?.model ? `<span>${esc(entry.source.model)}</span>` : ''}
        ${entry.completed ? '<span class="badge ok">✓ Logged</span>' : ''}
      </div>
      <h2 class="wod-title">${esc(w.title)}</h2>
      ${partsHtml(w)}
      <button type="button" class="btn primary big start-btn" id="start-btn">▶ Start Workout</button>
    </article>

    <article class="card coach-card">
      <h3>Coach's Notes</h3>
      <div class="story">${renderMarkdown(w.story_version || 'No notes provided.')}</div>
    </article>

    <article class="card refine-card">
      <h3>Tweak this WOD</h3>
      <p class="muted small-text">Tell the coach what to change. It keeps the rest of the workout.</p>
      <div class="chips quick" id="quick-feedback">
        ${QUICK_FEEDBACK.map((q) => `<button type="button" class="chip" data-value="${esc(q)}">${esc(q)}</button>`).join('')}
      </div>
      <form id="refine-form" class="refine-form">
        <textarea id="refine-input" rows="2" placeholder="e.g. replace the running with burpees"></textarea>
        <button type="submit" class="btn primary" id="refine-btn"><span class="btn-label">Update WOD</span></button>
      </form>
      ${
        entry.feedback?.length
          ? `<div class="fb-log"><span class="muted small-text">Changes so far</span><ul>${entry.feedback
              .map((f) => `<li>${esc(f)}</li>`)
              .join('')}</ul></div>`
          : ''
      }
    </article>`;

  $('#start-btn').addEventListener('click', () => startWorkout(entry));
  $('#quick-feedback').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const input = $('#refine-input');
    input.value = input.value.trim() ? `${input.value.trim()}. ${chip.dataset.value}` : chip.dataset.value;
    input.focus();
  });
  $('#refine-form').addEventListener('submit', (e) => {
    e.preventDefault();
    refineCurrent($('#refine-input').value, $('#refine-btn'));
  });
}

// =====================================================================
// Workout mode
// =====================================================================

const wo = {
  root: $('#workout'),
  phase: $('#wo-phase'),
  sub: $('#wo-sub'),
  clock: $('#wo-clock'),
  meta: $('#wo-meta'),
  bar: $('#wo-bar'),
  move: $('#wo-move'),
  moveLabel: $('#wo-move-label'),
  reps: $('#wo-reps'),
  name: $('#wo-name'),
  weight: $('#wo-weight'),
  tapHint: $('#wo-tap-hint'),
  next: $('#wo-next'),
  list: $('#wo-list'),
  prev: $('#wo-prev'),
  toggle: $('#wo-toggle'),
  fwd: $('#wo-fwd'),
  done: $('#wo-done'),
  skip: $('#wo-skip'),
  close: $('#wo-close'),
};

let session = null; // { entry, timer, loop, wakeLock, listKey }

async function requestWakeLock() {
  try {
    if (session && 'wakeLock' in navigator) session.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    /* denied or unsupported */
  }
}

function releaseWakeLock() {
  session?.wakeLock?.release?.().catch(() => {});
  if (session) session.wakeLock = null;
}

function startWorkout(entry) {
  unlockAudio(); // must run inside the tap
  const phases = buildPlan(entry.wod, state.settings);
  const timer = new WorkoutTimer(phases, {
    onCue: (cue) => {
      if (state.settings.beeps) beep(cue.type);
      if (state.settings.voice && cue.say) speak(cue.say);
    },
    onFinish: (results) => finishWorkout(results),
  });
  session = { entry, timer, loop: null, wakeLock: null, listKey: '' };
  wo.root.hidden = false;
  document.body.classList.add('in-workout');
  requestWakeLock();
  timer.start();
  session.loop = setInterval(renderWorkout, 200);
  renderWorkout();
}

function closeWorkout() {
  if (!session) return;
  clearInterval(session.loop);
  releaseWakeLock();
  stopSpeech();
  wo.root.hidden = true;
  document.body.classList.remove('in-workout');
}

function renderList(movements, currentIndex) {
  const key = `${movements.map((m) => m.name).join('|')}#${currentIndex}`;
  if (key === session.listKey) return;
  session.listKey = key;
  wo.list.innerHTML = movements
    .map(
      (m, i) => `<li class="${i === currentIndex ? 'current' : ''}">
        <span class="wl-reps">${esc(m.reps_or_time)}</span>
        <span class="wl-name">${esc(m.name)}</span>
        <span class="wl-weight">${esc(m.weight_rx)}</span>
      </li>`,
    )
    .join('');
}

function showMovement(label, m) {
  wo.moveLabel.textContent = label;
  wo.reps.textContent = m?.reps_or_time ?? '';
  wo.name.textContent = m?.name ?? '';
  wo.weight.textContent = m?.weight_rx ?? '';
}

function renderWorkout() {
  if (!session) return;
  const { timer } = session;
  timer.tick();
  if (timer.finished) return;

  const s = timer.snapshot();
  const p = s.phase;
  const up = (x) => Math.ceil(x - 1e-6);
  let clock;
  let urgent = false;
  let stateName = p.kind;

  if (p.kind !== 'piece') {
    const next = p.upNext;
    wo.phase.textContent = p.label;
    wo.sub.textContent = `Up next: ${p.upNextLabel}${next.title ? ` · ${next.title}` : ''}`;
    wo.meta.textContent = `${next.workout_type} · ${next.time_cap_minutes} min`;
    clock = up(s.remaining);
    urgent = s.remaining <= 3;
    showMovement('First up', next.movements[0]);
    wo.next.textContent = '';
    renderList(next.movements, 0);
  } else {
    wo.phase.textContent = `${p.label} · ${p.type}`;
    const cur = p.movements[s.movementIndex];
    const next = s.nextMovementIndex != null ? p.movements[s.nextMovementIndex] : null;
    stateName = 'work';

    switch (p.type) {
      case 'AMRAP':
        clock = up(s.remaining);
        urgent = s.remaining <= 10;
        wo.sub.textContent = `Round ${s.rounds + 1}`;
        wo.meta.textContent = `${fmtClock(s.elapsed)} elapsed · ${s.rounds} ${s.rounds === 1 ? 'round' : 'rounds'} done`;
        break;
      case 'For Time':
        clock = Math.floor(s.elapsed);
        urgent = s.remaining <= 10;
        wo.sub.textContent = `Round ${Math.min(s.rounds + 1, p.targetRounds)} / ${p.targetRounds}`;
        wo.meta.textContent = `Cap ${fmtClock(p.duration)} · ${fmtClock(up(s.remaining))} left`;
        break;
      default: {
        // EMOM / TABATA
        const iv = s.interval;
        clock = up(s.intervalRemaining);
        urgent = s.intervalRemaining <= 3;
        if (iv.kind === 'rest') stateName = 'interval-rest';
        wo.sub.textContent = p.type === 'TABATA' ? `${iv.label} · ${iv.kind === 'work' ? 'WORK' : 'REST'}` : iv.label;
        wo.meta.textContent = `${fmtClock(up(s.remaining))} total left`;
      }
    }

    const resting = s.interval?.kind === 'rest';
    showMovement(resting ? 'Rest · next up' : 'Now', cur);
    wo.next.textContent = !resting && next && p.movements.length > 1 ? `Next: ${movementText(next)}` : '';
    renderList(p.movements, s.movementIndex);
  }

  wo.clock.textContent = fmtClock(clock);
  wo.bar.style.transform = `scaleX(${Math.min(1, Math.max(0, s.progress))})`;
  wo.root.dataset.state = stateName;
  wo.root.classList.toggle('urgent', urgent);
  wo.root.classList.toggle('paused', !s.running);
  wo.toggle.textContent = s.running ? 'Pause' : 'Resume';

  const manual = p.kind === 'piece' && p.manual;
  wo.prev.hidden = !manual;
  wo.fwd.hidden = !manual;
  wo.tapHint.hidden = !manual;
  wo.done.hidden = !(p.kind === 'piece' && p.type === 'For Time');
  wo.skip.textContent = p.kind === 'piece' ? 'Skip' : 'Skip ▸▸';
}

wo.toggle.addEventListener('click', () => {
  unlockAudio();
  session?.timer.toggle();
  renderWorkout();
});
wo.move.addEventListener('click', () => {
  session?.timer.nextMovement();
  wo.move.classList.remove('bump');
  void wo.move.offsetWidth; // restart animation
  wo.move.classList.add('bump');
  renderWorkout();
});
wo.fwd.addEventListener('click', () => {
  session?.timer.nextMovement();
  renderWorkout();
});
wo.prev.addEventListener('click', () => {
  session?.timer.prevMovement();
  renderWorkout();
});
wo.done.addEventListener('click', () => {
  session?.timer.done();
  renderWorkout();
});
wo.skip.addEventListener('click', () => {
  session?.timer.skip();
  renderWorkout();
});
wo.close.addEventListener('click', () => {
  if (!session) return;
  if (!confirm('End this workout?')) return;
  const { timer } = session;
  if (timer.results.length || (timer.phase.kind === 'piece' && timer.elapsed > 0)) {
    timer.stop(); // triggers finishWorkout via onFinish
  } else {
    timer.finished = true;
    closeWorkout();
    session = null;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && !session.timer.finished) {
    requestWakeLock();
    renderWorkout();
  }
});

// =====================================================================
// Summary + logging
// =====================================================================

const summary = $('#summary');

function finishWorkout(results) {
  const entry = session.entry;
  const durationSec = Math.round(session.timer.totalElapsed / 1000);
  closeWorkout();
  session = null;

  $('#summary-results').innerHTML = results.length
    ? results.map((r) => `<li><span class="sr-label">${esc(r.label)} · ${esc(r.type)}</span><span class="sr-text">${esc(r.text)}</span></li>`).join('')
    : '<li><span class="sr-text">No work recorded</span></li>';
  $('#summary-note').value = '';
  summary.dataset.entryId = entry.id;
  summary.dataset.duration = String(durationSec);
  summary._results = results;
  summary.showModal();
}

function logCompletion(entryId, completion) {
  let entry = state.history.find((h) => h.id === entryId);
  if (!entry) return;
  if (entry.completed) {
    // Repeating a past WOD: log it as its own session.
    entry = { ...structuredClone(entry), id: newId(), createdAt: Date.now() };
    state.history.unshift(entry);
    state.currentId = entry.id;
  }
  entry.completed = completion;
  persistHistory();
  renderCurrent();
}

$('#summary-save').addEventListener('click', () => {
  logCompletion(summary.dataset.entryId, {
    at: Date.now(),
    results: summary._results ?? [],
    note: $('#summary-note').value.trim(),
    durationSec: Number(summary.dataset.duration) || 0,
  });
  summary.close();
});
$('#summary-discard').addEventListener('click', () => summary.close());

// =====================================================================
// History
// =====================================================================

function renderHistory() {
  const list = $('#history-list');
  if (!state.history.length) {
    list.innerHTML = '<li class="empty">No workouts yet.</li>';
    return;
  }
  list.innerHTML = state.history
    .map((h) => {
      const w = h.wod;
      const focus = h.prefs?.focus?.length ? h.prefs.focus.join(', ') : "Coach's choice";
      const results = h.completed?.results?.map((r) => esc(r.text)).join(' · ');
      return `
      <li class="history-item ${h.id === state.currentId ? 'current' : ''}" data-id="${esc(h.id)}">
        <div class="hi-top">
          <span class="badge accent">${esc(describeParts(w))}</span>
          <span class="hi-date">${esc(formatDate(h.completed?.at ?? h.createdAt))}</span>
          ${h.completed ? '<span class="badge ok">✓ Done</span>' : '<span class="badge">Not done</span>'}
        </div>
        <div class="hi-title">${esc(w.title)}</div>
        <div class="hi-sub">${esc(focus)} · ${esc(w.parts.flatMap((p) => p.movements.map((m) => m.name)).join(', '))}</div>
        ${results ? `<div class="hi-result">${results}</div>` : ''}
        ${h.completed?.note ? `<div class="hi-note">“${esc(h.completed.note)}”</div>` : ''}
        <div class="hi-actions">
          <button type="button" class="btn small" data-action="open">Open</button>
          ${h.completed ? '' : '<button type="button" class="btn small ghost" data-action="done">Mark done</button>'}
          <button type="button" class="btn small ghost danger" data-action="delete">Delete</button>
        </div>
      </li>`;
    })
    .join('');
}

$('#history-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.closest('.history-item').dataset.id;
  const entry = state.history.find((h) => h.id === id);
  if (!entry) return;

  switch (btn.dataset.action) {
    case 'open':
      state.currentId = id;
      persistHistory();
      renderCurrent();
      showView('wod');
      break;
    case 'done':
      entry.completed = { at: Date.now(), results: [{ label: 'Workout', type: describeParts(entry.wod), text: 'Logged manually' }], note: '' };
      persistHistory();
      renderHistory();
      break;
    case 'delete':
      if (!confirm(`Delete "${entry.wod.title}"?`)) return;
      state.history = state.history.filter((h) => h.id !== id);
      if (state.currentId === id) state.currentId = null;
      persistHistory();
      renderHistory();
      renderCurrent();
      break;
  }
});

$('#history-clear').addEventListener('click', () => {
  if (!state.history.length || !confirm('Delete all workout history? The coach will lose its memory of past sessions.')) return;
  state.history = [];
  state.currentId = null;
  persistHistory();
  renderHistory();
  renderCurrent();
});

// =====================================================================
// Settings
// =====================================================================

function persistSettings() {
  saveSettings(state.settings);
}

function renderEquipment() {
  $('#equipment-list').innerHTML = state.settings.equipment
    .map((item, i) => `<li class="tag">${esc(item)}<button type="button" data-index="${i}" aria-label="Remove ${esc(item)}">×</button></li>`)
    .join('');
}

$('#equipment-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-index]');
  if (!btn) return;
  state.settings.equipment = state.settings.equipment.filter((_, i) => i !== Number(btn.dataset.index));
  persistSettings();
  renderEquipment();
});

$('#equipment-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#equipment-input');
  const value = input.value.trim();
  if (value && !state.settings.equipment.some((x) => x.toLowerCase() === value.toLowerCase())) {
    state.settings.equipment = [...state.settings.equipment, value];
    persistSettings();
    renderEquipment();
  }
  input.value = '';
});

function renderInstructions() {
  $('#instructions-input').value = state.settings.systemInstructions ?? DEFAULT_SYSTEM_INSTRUCTIONS;
}

function flashSaved() {
  const note = $('#instructions-saved');
  note.hidden = false;
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => (note.hidden = true), 1800);
}

$('#instructions-save').addEventListener('click', () => {
  const value = $('#instructions-input').value.trim();
  state.settings.systemInstructions = !value || value === DEFAULT_SYSTEM_INSTRUCTIONS ? null : value;
  persistSettings();
  flashSaved();
});

$('#instructions-reset').addEventListener('click', () => {
  if (!confirm('Replace your instructions with the default Gem instructions?')) return;
  state.settings.systemInstructions = null;
  persistSettings();
  renderInstructions();
  flashSaved();
});

function fillSettingInputs() {
  $$('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    if (input.type === 'checkbox') input.checked = !!state.settings[key];
    else input.value = state.settings[key];
  });
}

function bindSettingInputs() {
  fillSettingInputs();
  $$('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    input.addEventListener('change', () => {
      if (input.type === 'checkbox') state.settings[key] = input.checked;
      else if (input.type === 'number') {
        const n = Math.round(Number(input.value));
        const min = Number(input.min);
        const max = Number(input.max);
        state.settings[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : state.settings[key];
        input.value = state.settings[key];
      } else state.settings[key] = input.value.trim();
      persistSettings();
    });
  });
}

$('#test-sounds').addEventListener('click', () => {
  unlockAudio();
  const seq = ['half', 'lastMinute', 'tenSec', 'tick', 'tick', 'tick', 'go', 'rest', 'end'];
  seq.forEach((type, i) => setTimeout(() => beep(type), i * 900));
  if (state.settings.voice) speak('Halfway. One minute left. Ten seconds.');
});

// ---------- AI provider + API key ----------

function showStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = !text;
}

const apiKeyInput = $('#apikey-input');
const apiKeyStatus = $('#apikey-status');
const modelInput = $('#model-input');

function renderProvider() {
  const id = state.settings.provider;
  const p = providerOf(id);
  $$('#provider-chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.value === id)));
  modelInput.value = state.settings[p.modelSetting];
  $('#apikey-label').textContent = `${p.label} API key`;
  $('#apikey-hint').textContent = p.keyHint;
  const link = $('#apikey-link');
  link.href = p.keyUrl;
  link.textContent = p.keyUrl.replace('https://', '');
  apiKeyInput.value = state.apiKeys[id] ?? '';
  showStatus(apiKeyStatus, '');
}

$('#provider-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.settings.provider = chip.dataset.value;
  persistSettings();
  renderProvider();
});

modelInput.addEventListener('change', () => {
  const value = modelInput.value.trim();
  if (value) state.settings[providerOf(state.settings.provider).modelSetting] = value;
  modelInput.value = state.settings[providerOf(state.settings.provider).modelSetting];
  persistSettings();
});

$('#apikey-toggle').addEventListener('click', (e) => {
  const show = apiKeyInput.type === 'password';
  apiKeyInput.type = show ? 'text' : 'password';
  e.target.textContent = show ? 'Hide' : 'Show';
});

$('#apikey-save').addEventListener('click', () => {
  const id = state.settings.provider;
  const key = apiKeyInput.value.trim();
  state.apiKeys[id] = key;
  saveApiKey(id, key);
  const label = providerOf(id).label;
  let msg = `Saved. ${label} WODs are generated directly from this phone.`;
  if (!key) msg = id === 'gemini' ? 'Key removed. Using the server key.' : `${label} key removed.`;
  showStatus(apiKeyStatus, msg);
});

$('#apikey-test').addEventListener('click', async () => {
  const id = state.settings.provider;
  const key = apiKeyInput.value.trim();
  if (!key) return showStatus(apiKeyStatus, 'Paste a key first.', true);
  showStatus(apiKeyStatus, 'Testing…');
  try {
    const name = await testApiKey(id, key, state.settings[providerOf(id).modelSetting]);
    showStatus(apiKeyStatus, `✓ Key works with ${name}.${key !== state.apiKeys[id] ? ' Tap Save to use it.' : ''}`);
  } catch (err) {
    showStatus(apiKeyStatus, `✕ ${err.message}`, true);
  }
});

// ---------- Backup ----------

const backupStatus = $('#backup-status');

async function exportBackup() {
  const data = {
    app: 'wod-timer',
    version: 1,
    exportedAt: new Date().toISOString(),
    history: state.history,
    settings: state.settings,
    prefs: state.prefs,
  };
  const name = `wod-timer-backup-${new Date().toLocaleDateString('sv')}.json`; // local YYYY-MM-DD
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });

  // iOS: the share sheet offers "Save to Files", AirDrop, Mail...
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'WOD Timer backup' });
      return showStatus(backupStatus, `Exported ${state.history.length} workouts.`);
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showStatus(backupStatus, `Exported ${state.history.length} workouts.`);
}

function importBackup(data) {
  if (data?.app !== 'wod-timer' || !Array.isArray(data.history)) throw new Error('This is not a WOD Timer backup file.');

  const byId = new Map(state.history.map((h) => [h.id, h]));
  let added = 0;
  for (const entry of data.history) {
    if (byId.has(entry?.id) || !upgradeEntry(entry)) continue;
    byId.set(entry.id, entry);
    added++;
  }
  state.history = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (!state.currentId && state.history.length) state.currentId = state.history[0].id;
  persistHistory();

  if (data.settings && confirm('Also restore equipment, coach instructions and timer settings from the backup?')) {
    state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    persistSettings();
    fillSettingInputs();
    renderEquipment();
    renderInstructions();
    renderProvider();
  }
  renderCurrent();
  renderHistory();
  return added;
}

$('#backup-export').addEventListener('click', exportBackup);
$('#backup-import').addEventListener('click', () => $('#backup-file').click());
$('#backup-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const added = importBackup(JSON.parse(await file.text()));
    showStatus(backupStatus, `Imported ${added} new workout${added === 1 ? '' : 's'}.`);
  } catch (err) {
    showStatus(backupStatus, err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, true);
  }
});

// =====================================================================
// Boot
// =====================================================================

function updateOnline() {
  $('#net-status').hidden = navigator.onLine;
}
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);

setupChips();
bindSettingInputs();
renderProvider();
renderEquipment();
renderInstructions();
renderCurrent();
updateOnline();
if (currentEntry()) $('#gen-panel').open = false;

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
  });
}
