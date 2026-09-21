// Web Audio API QQ-Style Sound Synthesizer

let audioCtx = null;
let isMuted = localStorage.getItem('chat_muted') === 'true';

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

/**
 * Classic QQ "滴滴滴" (Di-di-di) message notification chime
 */
export function playMessageSound() {
  if (isMuted) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const beeps = [0, 0.08, 0.16]; // 3 quick pulses

    beeps.forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1046.5, now + delay); // C6 Note

      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(0.2, now + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.05);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + delay);
      osc.stop(now + delay + 0.06);
    });
  } catch (err) {
    console.warn('Audio playback failed', err);
  }
}

/**
 * QQ "戳一戳" (Poke) Sound Effect
 */
export function playPokeSound() {
  if (isMuted) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(150, now + 0.15);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.2);
  } catch (err) {
    console.warn('Poke audio failed', err);
  }
}

export function toggleMute() {
  isMuted = !isMuted;
  localStorage.setItem('chat_muted', String(isMuted));
  return isMuted;
}

export function getMuteState() {
  return isMuted;
}
