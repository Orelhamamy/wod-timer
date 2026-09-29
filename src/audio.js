// Synthesized beeps (Web Audio) and optional voice callouts (Speech Synthesis).
// iOS only allows audio after a user gesture, so call unlockAudio() from a tap.

let ctx = null;

export function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') ctx.resume();

  // Mix with the user's music instead of stopping it (Safari 17+).
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'transient';
  } catch {
    /* unsupported */
  }

  // A silent buffer fully unlocks output on older iOS versions.
  const buffer = ctx.createBuffer(1, 1, 22050);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0);

  // Prime speech synthesis inside the gesture too.
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}

function tone(freq, offset, duration, { type = 'square', volume = 0.22 } = {}) {
  const t0 = ctx.currentTime + offset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.01);
  gain.gain.setValueAtTime(volume, t0 + duration - 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

// [frequency Hz, start offset s, duration s]
const PATTERNS = {
  tick: [[880, 0, 0.14]],
  go: [[1320, 0, 0.6]],
  rest: [[520, 0, 0.18], [390, 0.22, 0.35]],
  tenSec: [[1175, 0, 0.1], [1175, 0.16, 0.1]],
  half: [[660, 0, 0.2], [990, 0.25, 0.35]],
  lastMinute: [[990, 0, 0.14], [990, 0.2, 0.14], [990, 0.4, 0.3]],
  end: [[1320, 0, 0.3], [990, 0.35, 0.3], [660, 0.7, 0.8]],
};

export function beep(type) {
  if (!ctx || ctx.state !== 'running') return;
  for (const [f, o, d] of PATTERNS[type] ?? PATTERNS.tick) tone(f, o, d);
}

export function speak(text) {
  if (!text || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  u.lang = 'en-US';
  speechSynthesis.speak(u);
}

export function stopSpeech() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
