/* ============================================================
   Sound lab: what the settings are, and the Web Audio graph that
   plays them.

   Two halves, on purpose:

     speed and pitch   an <audio> element's own playbackRate and
                       preservesPitch. No Web Audio, no CORS, always
                       available. player.js applies these.
     reverb, EQ, bass  a Web Audio graph. Needs the element's audio to
                       be readable, which for a cross-origin file means
                       the element was loaded in CORS mode and the
                       server agreed. player.js probes that before it
                       builds anything, because a media element routed
                       through Web Audio plays SILENCE for a response
                       it may not read, and nothing says so.

   This file has no DOM and no element of its own. createFx() takes
   the AudioContext constructor, so a harness with no sound card can
   hand it a fake and look at what was connected and set.
   ============================================================ */

/** The ten EQ bands, in Hz. */
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Sliders' limits. Kept here so the panel, the store and the graph
    clamp to the same numbers. */
export const LIMITS = {
  rate: [0.5, 1.5],
  reverb: [0, 1],
  bass: [0, 12],
  eq: [-12, 12]
};

export const ROOMS = ['room', 'hall', 'cave'];

export function neutral() {
  return {
    /** Playback speed. 1 is as recorded. */
    rate: 1,
    /** True: the pitch follows the speed (slowed goes down, sped up
        goes up). False: the speed changes and the pitch is kept. */
    linked: true,
    /** Reverb amount, 0 (none) to 1. */
    reverb: 0,
    room: 'hall',
    /** Low-shelf boost in dB, 0 to 12. */
    bass: 0,
    /** Ten gains in dB, one per BANDS entry. */
    eq: BANDS.map(() => 0)
  };
}

function clamp(n, [lo, hi], fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/** A complete, clamped settings object from anything: a partial one,
    a stored one from an older build, junk. Never throws. */
export function clean(input) {
  const base = neutral();
  const s = input && typeof input === 'object' ? input : {};
  const eq = Array.isArray(s.eq) ? s.eq : [];
  return {
    rate: Math.round(clamp(s.rate, LIMITS.rate, base.rate) * 100) / 100,
    linked: s.linked === undefined ? base.linked : Boolean(s.linked),
    reverb: Math.round(clamp(s.reverb, LIMITS.reverb, 0) * 100) / 100,
    room: ROOMS.includes(s.room) ? s.room : base.room,
    bass: Math.round(clamp(s.bass, LIMITS.bass, 0) * 10) / 10,
    eq: BANDS.map((_, i) => Math.round(clamp(eq[i], LIMITS.eq, 0) * 10) / 10)
  };
}

/** True when nothing differs from the recording. */
export function isNeutral(settings) {
  const s = clean(settings);
  return s.rate === 1 && s.reverb === 0 && s.bass === 0 && s.eq.every((g) => g === 0);
}

/** True when the settings need the Web Audio graph (speed alone does
    not). */
export function needsGraph(settings) {
  const s = clean(settings);
  return s.reverb > 0 || s.bass > 0 || s.eq.some((g) => g !== 0);
}

export function same(a, b) {
  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}

/** The named starting points. Each is a full settings object, so
    choosing one replaces whatever was set. */
export const PRESETS = [
  { id: 'flat', name: 'As recorded', settings: neutral() },
  {
    id: 'slowed',
    name: 'Slowed and reverb',
    settings: clean({ rate: 0.85, linked: true, reverb: 0.45, room: 'cave', bass: 3 })
  },
  { id: 'spedup', name: 'Sped up', settings: clean({ rate: 1.15, linked: true }) },
  { id: 'nightcore', name: 'Nightcore', settings: clean({ rate: 1.3, linked: true }) },
  {
    id: 'bass',
    name: 'Bass boost',
    settings: clean({ bass: 9, eq: [4, 3, 2, 0, 0, 0, 0, 0, 0, 0] })
  },
  {
    id: 'bright',
    name: 'Bright',
    settings: clean({ eq: [0, 0, 0, 0, 0, 1, 2, 4, 5, 5] })
  },
  {
    id: 'vocal',
    name: 'Vocal focus',
    settings: clean({ eq: [-3, -2, -1, 0, 2, 3, 3, 1, 0, 0] })
  }
];

/** The preset that matches these settings exactly, or null. */
export function presetFor(settings) {
  const hit = PRESETS.find((p) => same(p.settings, settings));
  return hit ? hit.id : null;
}

/* ---------- Remembering ----------
   Per song, or one set for every song. localStorage, because it is a
   per-viewer convenience and nothing breaks without it. The map is
   capped so a long listening life cannot grow it without end: the
   oldest-touched songs go first. */

const STORE_KEY = '999:lab';
const KEEP_SONGS = 400;

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        all: raw.all ? clean(raw.all) : null,
        songs: raw.songs && typeof raw.songs === 'object' ? raw.songs : {},
        order: Array.isArray(raw.order) ? raw.order : []
      };
    }
  } catch { /* unreadable or refused */ }
  return { all: null, songs: {}, order: [] };
}

function writeStore(store) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* refused */ }
}

/** The settings a track should play with, and where they came from:
    its own ('song'), the all-songs set ('all'), or none ('none'). */
export function recall(key) {
  const store = readStore();
  if (key && store.songs[key]) return { scope: 'song', settings: clean(store.songs[key]) };
  if (store.all) return { scope: 'all', settings: store.all };
  return { scope: 'none', settings: neutral() };
}

/** Keep settings for a song (scope 'song') or for every song ('all').
    A song set back to the recording while an all-songs set exists is
    kept as its own neutral entry, so it does not fall back to the
    all-songs set; with no all-songs set its entry is simply dropped. */
export function remember(key, scope, settings) {
  const store = readStore();
  const s = clean(settings);

  if (scope === 'all') {
    store.all = isNeutral(s) ? null : s;
  } else if (key) {
    store.order = store.order.filter((k) => k !== key);
    if (isNeutral(s) && !store.all) {
      delete store.songs[key];
    } else {
      store.songs[key] = s;
      store.order.push(key);
      while (store.order.length > KEEP_SONGS) delete store.songs[store.order.shift()];
    }
  }
  writeStore(store);
}

/** Forget a song's own settings, so it falls back to the all-songs
    set or to the recording. */
export function forget(key) {
  const store = readStore();
  if (key) {
    delete store.songs[key];
    store.order = store.order.filter((k) => k !== key);
    writeStore(store);
  }
}

/* ---------- The graph ----------

     source(s) -> input -> 10 EQ bands -> bass shelf -+-> dry ---------+
                                                       +-> reverb -> wet +-> limiter -> out

   Every source joins at `input`, so the second element a crossfade
   uses sounds the same as the first. The limiter is a gentle
   compressor: boosts add up, and a clipped boost is the one thing a
   sound lab must not do to a song. */

const ROOM_SHAPE = {
  // seconds of tail, how fast it dies, how much the highs are rolled off
  room: { seconds: 0.9, decay: 3.0, soften: 0.55 },
  hall: { seconds: 2.4, decay: 2.5, soften: 0.35 },
  cave: { seconds: 4.2, decay: 2.2, soften: 0.14 }
};

/** A stereo impulse response made from decaying noise, with the highs
    rolled off by a one-pole filter so the tail is dark rather than
    hissy. There is no file to ship. */
export function impulse(ctx, room) {
  const shape = ROOM_SHAPE[room] || ROOM_SHAPE.hall;
  const rate = ctx.sampleRate || 44100;
  const length = Math.max(1, Math.floor(shape.seconds * rate));
  const pre = Math.floor(0.02 * rate);
  const buffer = ctx.createBuffer(2, length, rate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < length; i++) {
      const x = i < pre ? 0 : (Math.random() * 2 - 1) * Math.pow(1 - i / length, shape.decay);
      y += shape.soften * (x - y);
      data[i] = y;
    }
  }
  return buffer;
}

/**
 * Make the graph, lazily. Nothing touches the AudioContext until
 * ensure() is called, so a session that never uses reverb or EQ never
 * creates one.
 *
 *   AudioCtx   the constructor; defaults to the window's.
 */
export function createFx(AudioCtx) {
  const Ctor = AudioCtx || (typeof window !== 'undefined'
    ? (window.AudioContext || window.webkitAudioContext)
    : null);

  let ctx = null;
  let built = null;
  const sources = new WeakMap();
  let room = null;

  function build() {
    const input = ctx.createGain();

    const bands = BANDS.map((hz, i) => {
      const f = ctx.createBiquadFilter();
      f.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = hz;
      if (f.type === 'peaking') f.Q.value = 1.1;
      f.gain.value = 0;
      return f;
    });

    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 110;
    bass.gain.value = 0;

    const dry = ctx.createGain();
    const wet = ctx.createGain();
    wet.gain.value = 0;
    const convolver = ctx.createConvolver();

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    let node = input;
    bands.forEach((f) => { node.connect(f); node = f; });
    node.connect(bass);
    bass.connect(dry);
    bass.connect(convolver);
    convolver.connect(wet);
    dry.connect(limiter);
    wet.connect(limiter);
    limiter.connect(ctx.destination);

    return { input, bands, bass, dry, wet, convolver, limiter };
  }

  return {
    /** Whether Web Audio exists here at all. */
    get supported() { return Boolean(Ctor); },
    get ready() { return Boolean(built); },
    get context() { return ctx; },

    /** Create the context and the graph. False when there is no Web
        Audio. Safe to call again. */
    ensure() {
      if (built) return true;
      if (!Ctor) return false;
      try {
        ctx = new Ctor();
        built = build();
        return true;
      } catch {
        ctx = null;
        built = null;
        return false;
      }
    },

    /** A context starts suspended until a user gesture. Called from
        a click and again from play. */
    resume() {
      if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        return Promise.resolve(ctx.resume()).catch(() => {});
      }
      return Promise.resolve();
    },

    /** Route an element through the graph. An element can only ever
        be attached once; this is idempotent. */
    attach(element) {
      if (!built || !element) return false;
      if (sources.has(element)) return true;
      try {
        const src = ctx.createMediaElementSource(element);
        src.connect(built.input);
        sources.set(element, src);
        return true;
      } catch {
        return false;
      }
    },

    has(element) { return sources.has(element); },

    /** Set the graph from settings. Changes glide over a few
        milliseconds so a drag does not click. */
    apply(settings) {
      if (!built) return;
      const s = clean(settings);
      const t = ctx.currentTime || 0;
      const glide = (param, value) => {
        if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(value, t, 0.02);
        else param.value = value;
      };

      built.bands.forEach((f, i) => glide(f.gain, s.eq[i]));
      glide(built.bass.gain, s.bass);
      glide(built.wet.gain, s.reverb * 0.9);
      glide(built.dry.gain, 1 - s.reverb * 0.3);

      if (room !== s.room) {
        room = s.room;
        built.convolver.buffer = impulse(ctx, s.room);
      }
    }
  };
}
