// Workout plan builder + timer engine. Pure logic, no DOM.

export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const spokenPiece = (piece) =>
  `${piece.workout_type === 'TABATA' ? 'Tabata' : piece.workout_type}, ${plural(piece.time_cap_minutes, 'minute')}`;

export const movementText = (m) => [m.reps_or_time, m.name].filter(Boolean).join(' ');

const PRIORITY = { tick: 1, go: 2, rest: 2, tenSec: 3, half: 4, lastMinute: 4, end: 5 };

// Collects cues keyed by time; when two land on the same second the more
// important sound wins and the spoken texts are joined.
function cueSet() {
  const map = new Map();
  return {
    add(atSec, type, say) {
      if (atSec <= 0) return;
      const at = Math.round(atSec * 1000);
      const prev = map.get(at);
      if (!prev) return void map.set(at, { at, type, say });
      if (PRIORITY[type] > PRIORITY[prev.type]) prev.type = type;
      if (say) prev.say = prev.say ? `${prev.say}. ${say}` : say;
    },
    list: () => [...map.values()].sort((a, b) => a.at - b.at),
  };
}

function countdownTicks(cues, endSec) {
  for (const s of [3, 2, 1]) cues.add(endSec - s, 'tick');
}

function wholePhaseCues(cues, dur, { tenSec = true } = {}) {
  if (dur >= 120) cues.add(dur / 2, 'half', 'Halfway');
  if (dur > 120) cues.add(dur - 60, 'lastMinute', 'One minute left');
  if (tenSec && dur >= 30) cues.add(dur - 10, 'tenSec', 'Ten seconds');
  countdownTicks(cues, dur);
}

function piecePhase(piece, label) {
  const n = piece.movements.length;
  const base = {
    kind: 'piece',
    label,
    title: piece.title ?? '',
    type: piece.workout_type,
    movements: piece.movements,
    duration: piece.time_cap_minutes * 60,
    direction: 'down',
    manual: false,
    intervals: null,
  };
  const cues = cueSet();

  switch (piece.workout_type) {
    case 'AMRAP':
      Object.assign(base, { manual: true });
      wholePhaseCues(cues, base.duration);
      break;

    case 'For Time':
      Object.assign(base, { manual: true, direction: 'up', targetRounds: piece.rounds ?? 1 });
      wholePhaseCues(cues, base.duration);
      break;

    case 'EMOM': {
      const minutes = piece.time_cap_minutes;
      base.intervals = Array.from({ length: minutes }, (_, i) => ({
        kind: 'work',
        start: i * 60,
        duration: 60,
        movementIndex: i % n,
        label: `Minute ${i + 1}/${minutes}`,
      }));
      base.intervals.forEach((iv) => {
        if (iv.start > 0) cues.add(iv.start, 'go', `Minute ${iv.start / 60 + 1}. ${movementText(piece.movements[iv.movementIndex])}`);
        // Every minute: half-minute beep at :30 and a 10-second warning at :50 (beeps only).
        cues.add(iv.start + 30, 'half');
        cues.add(iv.start + 50, 'tenSec');
        countdownTicks(cues, iv.start + iv.duration);
      });
      wholePhaseCues(cues, base.duration, { tenSec: false });
      break;
    }

    case 'TABATA': {
      const rounds = Math.max(1, Math.round((piece.time_cap_minutes * 60) / 30));
      const intervals = [];
      let t = 0;
      for (let r = 0; r < rounds; r++) {
        intervals.push({ kind: 'work', start: t, duration: 20, movementIndex: r % n, label: `Round ${r + 1}/${rounds}` });
        t += 20;
        if (r < rounds - 1) {
          // Rest shows the upcoming movement. No rest after the final round.
          intervals.push({ kind: 'rest', start: t, duration: 10, movementIndex: (r + 1) % n, label: `Round ${r + 1}/${rounds}` });
          t += 10;
        }
      }
      base.intervals = intervals;
      base.duration = t;
      intervals.forEach((iv) => {
        if (iv.start > 0) {
          if (iv.kind === 'rest') cues.add(iv.start, 'rest', 'Rest');
          else cues.add(iv.start, 'go', piece.movements[iv.movementIndex].name);
        }
        countdownTicks(cues, iv.start + iv.duration);
      });
      wholePhaseCues(cues, base.duration, { tenSec: false });
      break;
    }
  }

  base.cues = cues.list();
  return base;
}

function simplePhase(kind, label, duration, upNext, upNextLabel) {
  const cues = cueSet();
  if (duration >= 30) cues.add(duration - 10, 'tenSec', 'Ten seconds');
  countdownTicks(cues, duration);
  return { kind, label, duration, direction: 'down', upNext, upNextLabel, cues: cues.list() };
}

/** Get ready -> part 1 -> rest -> part 2 ... -> rest -> core finisher. */
export function buildPlan(wod, { prepSeconds = 10, transitionSeconds = 60 } = {}) {
  const multi = wod.parts.length > 1;
  const pieces = wod.parts.map((piece, i) => ({ piece, label: multi ? `Part ${i + 1}` : 'Main WOD' }));
  if (wod.finisher) pieces.push({ piece: wod.finisher, label: 'Core Finisher' });

  const phases = [];
  pieces.forEach(({ piece, label }, i) => {
    if (i === 0 && prepSeconds > 0) phases.push(simplePhase('prep', 'Get Ready', prepSeconds, piece, label));
    if (i > 0 && transitionSeconds > 0) phases.push(simplePhase('rest', 'Rest', transitionSeconds, piece, label));
    phases.push(piecePhase(piece, label));
  });
  return phases;
}

// Cues aren't replayed after a long gap (e.g. the phone was locked).
const MAX_CUE_GAP_MS = 2500;

export class WorkoutTimer {
  /**
   * @param {Array} phases from buildPlan()
   * @param {{onCue?: Function, onPhase?: Function, onFinish?: Function}} handlers
   */
  constructor(phases, handlers = {}) {
    this.phases = phases;
    this.h = handlers;
    this.index = 0;
    this.elapsed = 0; // ms inside current phase
    this.totalElapsed = 0;
    this.running = false;
    this.finished = false;
    this.last = 0;
    this.movementIndex = 0; // manual phases only
    this.rounds = 0; // completed rounds, manual phases only
    this.results = [];
  }

  get phase() {
    return this.phases[this.index];
  }

  start() {
    this.running = true;
    this.last = performance.now();
    this._enter();
  }

  pause() {
    if (!this.running) return;
    this.tick();
    this.running = false;
  }

  resume() {
    if (this.running || this.finished) return;
    this.running = true;
    this.last = performance.now();
  }

  toggle() {
    this.running ? this.pause() : this.resume();
  }

  tick() {
    if (!this.running || this.finished) return;
    const now = performance.now();
    let delta = now - this.last;
    this.last = now;
    const gap = delta > MAX_CUE_GAP_MS;

    // Loop so a long gap correctly carries across phase boundaries.
    while (delta > 0 && !this.finished) {
      const p = this.phase;
      const durMs = p.duration * 1000;
      const prev = this.elapsed;
      const step = Math.min(delta, durMs - prev);
      this.elapsed = prev + step;
      this.totalElapsed += step;
      delta -= step;
      if (!gap) {
        for (const c of p.cues) if (c.at > prev && c.at <= this.elapsed) this.h.onCue?.(c);
      }
      if (this.elapsed >= durMs) this._complete('time');
    }
  }

  /** Manual phases: athlete finished the current movement. */
  nextMovement() {
    const p = this.phase;
    if (!p?.manual || !this.running) return;
    this.movementIndex++;
    if (this.movementIndex >= p.movements.length) {
      this.movementIndex = 0;
      this.rounds++;
      if (p.type === 'For Time' && this.rounds >= p.targetRounds) return this._complete('done');
    }
  }

  prevMovement() {
    const p = this.phase;
    if (!p?.manual) return;
    if (this.movementIndex > 0) this.movementIndex--;
    else if (this.rounds > 0) {
      this.rounds--;
      this.movementIndex = p.movements.length - 1;
    }
  }

  /** For Time: athlete finished before the cap. */
  done() {
    if (this.phase?.kind === 'piece') this._complete('done');
  }

  skip() {
    if (!this.finished) this._complete('skipped');
  }

  stop() {
    if (this.finished) return;
    this.tick();
    const p = this.phase;
    if (p.kind === 'piece' && this.elapsed > 0) this.results.push(this._result(p, 'stopped'));
    this.finished = true;
    this.running = false;
    this.h.onFinish?.(this.results, { early: true });
  }

  currentInterval() {
    const p = this.phase;
    if (!p?.intervals) return null;
    const t = this.elapsed / 1000;
    for (let i = p.intervals.length - 1; i >= 0; i--) if (t >= p.intervals[i].start) return p.intervals[i];
    return p.intervals[0];
  }

  snapshot() {
    const p = this.phase;
    const elapsed = this.elapsed / 1000;
    const snap = {
      phase: p,
      phaseIndex: this.index,
      elapsed,
      remaining: p.duration - elapsed,
      progress: p.duration ? elapsed / p.duration : 0,
      running: this.running,
      finished: this.finished,
      rounds: this.rounds,
      interval: null,
      movementIndex: null,
      nextMovementIndex: null,
    };
    if (p.kind !== 'piece') return snap;

    const n = p.movements.length;
    if (p.manual) {
      snap.movementIndex = this.movementIndex;
      snap.nextMovementIndex = (this.movementIndex + 1) % n;
    } else {
      const iv = this.currentInterval();
      snap.interval = iv;
      snap.intervalRemaining = iv.start + iv.duration - elapsed;
      snap.movementIndex = iv.movementIndex;
      const ivIndex = p.intervals.indexOf(iv);
      const nextWork = p.intervals.slice(ivIndex + 1).find((x) => x.kind === 'work');
      snap.nextMovementIndex = iv.kind === 'rest' ? iv.movementIndex : nextWork?.movementIndex ?? null;
    }
    return snap;
  }

  /** Returns the cue for starting the current phase. */
  _enterCue() {
    const p = this.phase;
    if (p.kind === 'prep') return { type: 'tick', say: 'Get ready' };
    if (p.kind === 'rest') return { type: 'rest', say: `Rest. Up next, ${p.upNextLabel}. ${spokenPiece(p.upNext)}` };
    const first = p.intervals ? p.movements[p.intervals[0].movementIndex] : p.movements[0];
    return { type: 'go', say: `Go! ${movementText(first)}` };
  }

  _enter(prefix) {
    this.h.onPhase?.(this.phase, this.index);
    const cue = this._enterCue();
    if (prefix) {
      // Coming straight out of a piece: one sound, one sentence.
      cue.type = cue.type === 'go' ? 'go' : 'end';
      cue.say = `${prefix} ${cue.say}`;
    }
    this.h.onCue?.(cue);
  }

  _complete(reason) {
    const p = this.phase;
    if (p.kind === 'piece') this.results.push(this._result(p, reason));
    this.index++;
    this.elapsed = 0;
    this.movementIndex = 0;
    this.rounds = 0;

    if (this.index >= this.phases.length) {
      this.finished = true;
      this.running = false;
      this.h.onCue?.({ type: 'end', say: 'Time! Great work.' });
      this.h.onFinish?.(this.results, { early: false });
      return;
    }
    this._enter(p.kind === 'piece' ? 'Time!' : '');
  }

  _result(p, reason) {
    const t = this.elapsed / 1000;
    const partial = `${plural(this.rounds, 'round')} + ${plural(this.movementIndex, 'movement')}`;
    let text;
    switch (p.type) {
      case 'AMRAP':
        text = reason === 'time' ? partial : `${partial} (stopped at ${fmtClock(t)})`;
        break;
      case 'For Time':
        if (reason === 'done') text = `Finished in ${fmtClock(t)}`;
        else if (reason === 'time') text = `Time capped at ${fmtClock(p.duration)}: ${partial}`;
        else text = `Stopped at ${fmtClock(t)}: ${partial}`;
        break;
      default:
        text = reason === 'time' ? 'Completed' : `Stopped at ${fmtClock(t)} of ${fmtClock(p.duration)}`;
    }
    return { label: p.label, type: p.type, text };
  }
}
