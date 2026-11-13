// Audio controller (plan R4 and R5). States: unarmed -> armed -> interrupted / failed.
// - arm() runs inside a user gesture: it creates and resumes the AudioContext, plays a 50 ms silent
//   buffer and primes the <audio src=audio/beep3.wav> element (play muted, pause, rewind, unmute).
// - The AudioContext dropping out of "running" (call, Siri, another app) moves it to interrupted.
// - ring() switches navigator.audioSession to "playback" (Web Audio then ignores the silent switch)
//   and plays the beeps; without audioSession it plays the <audio> element, which plays as media and
//   ignores the switch. Whichever path throws, the other one is used. Never both: no double beep.
// - ring() resolves to the path that really played: a rejected <audio>.play() (no gesture, load
//   error, interrupted session) falls back to Web Audio, and when nothing plays the state becomes
//   "failed" so the "Tap to re-arm" bar shows. The alarm escalates: later repeats are louder and
//   longer (escalation()).
// - quiet() sets the audio session back to "auto" so the user's music keeps playing while cooking.
// - nudge() (page visible again) resumes a context that was unlocked before; WebKit allows that
//   without a gesture.

export const BEEP_URL = "audio/beep3.wav";

/**
 * @typedef {{ type: string }} AudioSessionLike
 * @typedef {{
 *   AudioContext?: new () => AudioContext,
 *   createAudio?: (src: string) => HTMLAudioElement,
 *   audioSession?: AudioSessionLike | null,
 *   userActive?: () => boolean,
 * }} AudioEnv
 */

/**
 * The browser's audio pieces (AudioContext, <audio>, navigator.audioSession).
 * @returns {AudioEnv}
 */
export function browserAudioEnv() {
  const w = /** @type {any} */ (globalThis);
  return {
    AudioContext: w.AudioContext || w.webkitAudioContext,
    createAudio: typeof w.Audio === "function" ? (/** @type {string} */ src) => new w.Audio(src) : undefined,
    audioSession: w.navigator && w.navigator.audioSession ? w.navigator.audioSession : null,
    // Transient user activation (click, touchend, keydown). Without the API, trust the caller.
    userActive: () => {
      const ua = w.navigator && w.navigator.userActivation;
      return ua ? !!ua.isActive : true;
    },
  };
}

/**
 * How loud and long alarm repeat `i` (0 = first ring) is: 3 beeps at gain 0.4, one more beep and
 * +0.2 gain per repeat, up to 6 beeps at full gain. The <audio> file (three beeps) plays once, or
 * twice from the fourth beep on.
 * @param {number} i
 */
export function escalation(i) {
  const n = Math.max(0, Math.floor(Number.isFinite(i) ? i : 0));
  const beeps = Math.min(6, 3 + n);
  return { beeps, gain: Math.min(1, Math.round((0.4 + 0.2 * n) * 10) / 10), plays: Math.ceil(beeps / 3) };
}

/**
 * 880 Hz beeps, 0.3 s each, every 0.35 s (the old page's beep), escalated by repeat index.
 * @param {AudioContext} ctx
 * @param {number} i
 */
function beeps(ctx, i) {
  const { beeps: n, gain } = escalation(i);
  for (let k = 0; k < n; k++) {
    const t = k * 0.35;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(gain, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
    o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
  }
}

/**
 * @param {AudioEnv} env
 */
export function createAudioController(env) {
  /** @type {import('../types').AudioState} */
  let state = "unarmed";
  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {HTMLAudioElement | null} */
  let el = null;
  let primed = false;
  /** The context ran once (unlocked by a gesture), so resume() may work later without one. */
  let unlocked = false;
  /** @type {Promise<import('../types').AudioState> | null} */
  let arming = null;
  /** @type {Set<(s: import('../types').AudioState) => void>} */
  const listeners = new Set();

  /** @param {import('../types').AudioState} s */
  function set(s) {
    if (s === state) return;
    state = s;
    for (const fn of listeners) { try { fn(s); } catch { /* ignore */ } }
  }

  /** @param {string} type */
  function sessionType(type) {
    const as = env.audioSession;
    if (!as) return;
    try { if (as.type !== type) as.type = type; } catch { /* unsupported value */ }
  }

  function onCtxState() {
    if (!ctx) return;
    if (ctx.state === "running") { if (state === "interrupted" || (state === "failed" && unlocked)) set("armed"); }
    else if (state === "armed") set("interrupted");
  }

  /** @returns {Promise<boolean>} */
  async function primeElement() {
    if (!env.createAudio) return false;
    // A muted play outside a real activation does not unlock unmuted playback on iOS.
    const active = env.userActive ? env.userActive() : true;
    try {
      if (!el) { el = env.createAudio(BEEP_URL); el.preload = "auto"; }
      el.muted = true;
      await el.play();
      el.pause();
      el.currentTime = 0;
      el.muted = false;
      if (active) primed = true;
    } catch {
      if (el) el.muted = false;
    }
    return primed;
  }

  /** @returns {Promise<boolean>} context running */
  async function startContext() {
    if (!env.AudioContext) return false;
    try {
      if (!ctx) {
        ctx = new env.AudioContext();
        ctx.addEventListener("statechange", onCtxState);
      }
      if (ctx.state !== "running") await ctx.resume();
      if (/** @type {string} */ (ctx.state) !== "running") return false;
      // A 50 ms silent buffer unlocks output on iOS.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * 0.05)), ctx.sampleRate || 44100);
      src.connect(ctx.destination);
      src.start(0);
      unlocked = true;
      return true;
    } catch {
      return false;
    }
  }

  const api = {
    /** @returns {import('../types').AudioState} */
    get state() { return state; },
    /** Web Audio and <audio> as found (for Settings). */
    support() {
      return { webAudio: !!env.AudioContext, element: !!env.createAudio, audioSession: !!env.audioSession };
    },
    /**
     * Arm inside a user gesture. Resolves to the new state. Calls made while one is in flight
     * share it, so a touchend and the click after it never race each other.
     * @returns {Promise<import('../types').AudioState>}
     */
    arm() {
      if (arming) return arming;
      arming = (async () => {
        try {
          const [running, el0] = await Promise.all([startContext(), primeElement()]);
          // With an AudioContext, armed means it runs (R4 treats a stopped context as needing a
          // tap). Without one, the primed element is enough.
          if (env.AudioContext ? running : el0) set("armed");
          else set("failed");
          return state;
        } finally {
          arming = null;
        }
      })();
      return arming;
    },
    /**
     * Play alarm repeat `i` (0 = first). Resolves to the path that really played, or null (then
     * the state is "failed" and the re-arm bar shows).
     * @param {number} [i]
     * @returns {Promise<'webaudio' | 'element' | null>}
     */
    async ring(i = 0) {
      sessionType("playback");
      const webAudio = () => {
        if (!ctx || ctx.state !== "running") return false;
        try { beeps(ctx, i); return true; } catch { return false; }
      };
      /** @returns {Promise<boolean>} */
      const element = async () => {
        if (!el && env.createAudio) { try { el = env.createAudio(BEEP_URL); } catch { return false; } }
        if (!el) return false;
        const a = el;
        try {
          // The file plays at full media volume; it escalates by playing more often.
          const { plays } = escalation(i);
          a.muted = false;
          let left = plays - 1;
          a.onended = () => {
            if (left-- > 0) { a.currentTime = 0; Promise.resolve(a.play()).catch(() => {}); }
          };
          a.currentTime = 0;
          await a.play();
          return true;
        } catch { return false; }
      };
      /** @type {'webaudio' | 'element' | null} */
      let path = null;
      // audioSession present: Web Audio (now "playback") first; absent: the media element first.
      if (env.audioSession) path = webAudio() ? "webaudio" : (await element()) ? "element" : null;
      else path = (await element()) ? "element" : webAudio() ? "webaudio" : null;
      if (!path) set("failed");
      return path;
    },
    /** Page visible again: resume a context a gesture unlocked before (no gesture needed). */
    nudge() {
      if (!ctx || !unlocked || ctx.state === "running") return;
      try { Promise.resolve(ctx.resume()).catch(() => {}); } catch { /* ignore */ }
    },
    /** Stop sounding and give the audio session back ("auto"), so music plays on. */
    quiet() {
      if (el) { try { el.onended = null; el.pause(); el.currentTime = 0; } catch { /* ignore */ } }
      sessionType("auto");
    },
    /** @param {(s: import('../types').AudioState) => void} fn */
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** Whether the <audio> element was primed (tests, Settings). */
    primed: () => primed,
  };
  return api;
}
