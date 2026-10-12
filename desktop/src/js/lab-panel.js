/* ============================================================
   The sound lab and the sleep timer: two panels over the bar.

   The lab is a mixing desk: the presets down the left, the ten band
   equalizer as one curve you drag in the middle, and speed, reverb and
   bass as knobs on the right. What is set is kept for the song, or for
   every song if the switch at the top says so. All of the audio work is
   in player.js and fx.js; this only draws the controls and says what
   the player said.

   Every control is a real range input underneath: the knobs and the
   curve's handles are what you see and drag, the inputs are what a
   keyboard and a screen reader reach. A drag sets the input and fires
   its `input` event, so the one change path below handles both.

   The sleep timer pauses the music after 15, 30 or 60 minutes, or at
   the end of the song that is playing.

   shell.js only.
   ============================================================ */

import { make } from './utils.js';
import { makePopover } from './popover.js';
import { PRESETS, BANDS, LIMITS, ROOMS, presetFor, clean, neutral } from './fx.js';

const NS = 'http://www.w3.org/2000/svg';

/** "31 Hz", "1 kHz". */
function hz(n) {
  return n >= 1000 ? `${n / 1000} kHz` : `${n} Hz`;
}

/** The short form under the curve: "31", "1k". */
function hzShort(n) {
  return n >= 1000 ? `${n / 1000}k` : String(n);
}

function signed(db) {
  const v = Math.round(db * 10) / 10;
  return `${v > 0 ? '+' : ''}${v} dB`;
}

/** Round to the step and hold inside the range. */
function snapTo(value, step, min, max) {
  const v = Math.round(value / step) * step;
  return Math.min(max, Math.max(min, Math.round(v * 1000) / 1000));
}

/** Set a range input as if it had been dragged. The listeners below
    then do what they do for a keyboard press. */
function fire(input) {
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  return el;
}

/**
 * A knob: a ring and a dial you drag up and down, over a range input.
 * `rest` is where a double press puts it back. Same shape as the old
 * slider: { el, input, show(value), readout(), gate(off) }.
 */
function knob({ label, min, max, step, format, id, rest }) {
  const el = make('div', 'lab-knob');

  const input = make('input', 'sr-only lab-knob-input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.id = id;

  const ring = make('div', 'lab-knob-ring');
  const dial = make('span', 'lab-knob-dial');
  dial.appendChild(make('span', 'lab-knob-mark'));
  ring.appendChild(dial);

  const out = make('span', 'lab-val mono', '');
  const name = make('label', 'lab-name', label);
  name.htmlFor = id;

  el.append(ring, input, out, name);

  function paintKnob() {
    const pct = max > min ? (Number(input.value) - min) / (max - min) : 0;
    el.style.setProperty('--k', String(Math.min(1, Math.max(0, pct))));
  }

  /** One drag: the distance up from where it was pressed. A full sweep
      is about a hundred and sixty pixels. */
  ring.addEventListener('pointerdown', (event) => {
    if (input.disabled || event.button !== 0) return;
    event.preventDefault();
    try { ring.setPointerCapture(event.pointerId); } catch { /* no capture */ }
    try { input.focus({ preventScroll: true }); } catch { /* fine */ }
    const startY = event.clientY;
    const startValue = Number(input.value);
    const move = (ev) => {
      const next = snapTo(startValue + ((startY - ev.clientY) / 160) * (max - min), step, min, max);
      if (String(next) !== input.value) {
        input.value = String(next);
        fire(input);
      }
    };
    const done = () => {
      ring.removeEventListener('pointermove', move);
      ring.removeEventListener('pointerup', done);
      ring.removeEventListener('pointercancel', done);
    };
    ring.addEventListener('pointermove', move);
    ring.addEventListener('pointerup', done);
    ring.addEventListener('pointercancel', done);
  });

  ring.addEventListener('dblclick', () => {
    if (input.disabled) return;
    input.value = String(rest);
    fire(input);
  });

  ring.addEventListener('wheel', (event) => {
    if (input.disabled) return;
    event.preventDefault();
    const dir = event.deltaY < 0 ? 1 : -1;
    const next = snapTo(Number(input.value) + dir * (max - min) * 0.02, step, min, max);
    if (String(next) !== input.value) {
      input.value = String(next);
      fire(input);
    }
  }, { passive: false });

  return {
    el,
    input,
    show(value) {
      // Never move the control out from under a hand that is on it
      if (document.activeElement !== input) input.value = String(value);
      out.textContent = format(Number(value));
      paintKnob();
    },
    readout() { out.textContent = format(Number(input.value)); paintKnob(); },
    gate(off) { input.disabled = off; el.classList.toggle('is-disabled', off); }
  };
}

/**
 * Start both panels.
 *
 *   player   the shell's player (onLab, setLab, resetLab, setLabScope,
 *            onSettings, onSleep, startSleep, cancelSleep)
 *   frame    the iframe the pages are shown in
 */
export function initLabPanel({ player, frame }) {
  /* ================= Sound lab ================= */
  const lab = makePopover({ id: 'labPanel', title: 'Sound lab', frame, wide: true });
  lab.el.classList.add('pop-lab');

  /* ---- the header: what it is kept for, and the two switches ---- */
  const note = make('p', 'lab-note');
  note.setAttribute('role', 'status');

  const scope = make('div', 'lab-scope');
  scope.setAttribute('role', 'group');
  scope.setAttribute('aria-label', 'Where these settings apply');
  const scopeSong = make('button', 'lab-scope-btn', 'This song');
  const scopeAll = make('button', 'lab-scope-btn', 'Every song');
  scopeSong.type = 'button';
  scopeAll.type = 'button';
  scope.append(scopeSong, scopeAll);

  const reset = make('button', 'btn btn-ghost lab-reset', 'Reset');
  reset.type = 'button';

  const tools = make('div', 'lab-tools');
  tools.append(note, scope, reset);
  const head = lab.el.querySelector('.pop-head');
  head.insertBefore(tools, head.querySelector('.pop-close'));

  /* ---- presets, down the left ---- */
  const presets = make('div', 'lab-chips lab-presets');
  presets.setAttribute('role', 'group');
  presets.setAttribute('aria-label', 'Presets');
  const chipFor = new Map();
  PRESETS.forEach((p) => {
    const b = make('button', 'lab-chip', p.name);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => player.setLab(p.settings));
    presets.appendChild(b);
    chipFor.set(p.id, b);
  });
  const colPresets = make('div', 'lab-col lab-col-presets');
  colPresets.append(make('p', 'lab-sub', 'Presets'), presets);

  /* ---- the equalizer, in the middle: one curve, ten handles ---- */
  const plot = make('div', 'lab-plot');

  [12, 6, 0, -6, -12].forEach((g) => {
    const at = `${((12 - g) / 24) * 100}%`;
    const line = make('span', g === 0 ? 'lab-grid is-zero' : 'lab-grid');
    line.style.top = at;
    const text = make('span', 'lab-grid-label mono', g > 0 ? `+${g}` : String(g));
    text.style.top = at;
    plot.append(line, text);
  });

  const curve = svg('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', class: 'lab-curve', 'aria-hidden': 'true' });
  const curveFill = svg('path', { class: 'lab-curve-fill' });
  const curveLine = svg('path', { class: 'lab-curve-line', 'vector-effect': 'non-scaling-stroke' });
  curve.append(curveFill, curveLine);
  plot.appendChild(curve);

  const bands = BANDS.map((f, i) => {
    const pt = make('span', 'lab-pt lab-band');
    pt.style.left = `${(i + 0.5) * 10}%`;

    const input = make('input', 'sr-only lab-pt-input');
    input.type = 'range';
    input.min = String(LIMITS.eq[0]);
    input.max = String(LIMITS.eq[1]);
    input.step = '0.5';
    input.id = `labEq${i}`;
    input.setAttribute('aria-label', hz(f));

    const dot = make('span', 'lab-pt-dot');
    const bubble = make('span', 'lab-pt-val mono', '');
    pt.append(input, dot, bubble);
    plot.appendChild(pt);

    return {
      el: pt,
      input,
      show(value) {
        if (document.activeElement !== input) input.value = String(value);
        bubble.textContent = signed(Number(value));
        pt.style.top = `${((12 - Number(value)) / 24) * 100}%`;
      },
      readout() {
        bubble.textContent = signed(Number(input.value));
        pt.style.top = `${((12 - Number(input.value)) / 24) * 100}%`;
      },
      gate(off) { input.disabled = off; pt.classList.toggle('is-disabled', off); }
    };
  });

  /** The curve through the ten points, smoothed, and filled down to the
      zero line. Drawn in a 100 by 100 box that stretches to the plot. */
  function drawCurve() {
    const xs = bands.map((_, i) => (i + 0.5) * 10);
    const ys = bands.map((b) => ((12 - Number(b.input.value)) / 24) * 100);
    let d = `M${xs[0]} ${ys[0]}`;
    for (let i = 0; i < xs.length - 1; i++) {
      const a = Math.max(0, i - 1);
      const z = Math.min(xs.length - 1, i + 2);
      const c1x = xs[i] + (xs[i + 1] - xs[a]) / 6;
      const c1y = ys[i] + (ys[i + 1] - ys[a]) / 6;
      const c2x = xs[i + 1] - (xs[z] - xs[i]) / 6;
      const c2y = ys[i + 1] - (ys[z] - ys[i]) / 6;
      d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${xs[i + 1]} ${ys[i + 1]}`;
    }
    curveLine.setAttribute('d', d);
    curveFill.setAttribute('d', `${d} L${xs[xs.length - 1]} 50 L${xs[0]} 50 Z`);
  }

  /** A press anywhere on the plot takes the band under it and moves it
      to the pointer's height; dragging carries on from there. */
  plot.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || bands[0].input.disabled) return;
    if (event.target && event.target.closest && event.target.closest('.sr-only')) return;
    const box = plot.getBoundingClientRect();
    if (!(box.width > 0) || !(box.height > 0)) return;
    event.preventDefault();
    try { plot.setPointerCapture(event.pointerId); } catch { /* no capture */ }

    const i = Math.min(BANDS.length - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * BANDS.length)));
    const band = bands[i];
    try { band.input.focus({ preventScroll: true }); } catch { /* fine */ }
    band.el.classList.add('is-drag');

    const set = (ev) => {
      const frac = Math.min(1, Math.max(0, (ev.clientY - box.top) / box.height));
      const next = snapTo(12 - frac * 24, 0.5, LIMITS.eq[0], LIMITS.eq[1]);
      if (String(next) !== band.input.value) {
        band.input.value = String(next);
        fire(band.input);
      }
    };
    const done = () => {
      band.el.classList.remove('is-drag');
      plot.removeEventListener('pointermove', set);
      plot.removeEventListener('pointerup', done);
      plot.removeEventListener('pointercancel', done);
    };
    plot.addEventListener('pointermove', set);
    plot.addEventListener('pointerup', done);
    plot.addEventListener('pointercancel', done);
    set(event);
  });

  const freqs = make('div', 'lab-freqs mono');
  BANDS.forEach((f) => freqs.appendChild(make('span', '', hzShort(f))));

  const eqBox = make('div', 'lab-eq');
  eqBox.append(plot, freqs);
  const eqHead = make('div', 'lab-eq-head');
  eqHead.append(make('p', 'lab-sub', 'Equalizer'), make('span', 'lab-eq-hint mono', 'drag a point, gain in dB'));
  const colEq = make('div', 'lab-col lab-col-eq');
  colEq.append(eqHead, eqBox);

  /* ---- speed, reverb and bass as knobs, on the right ---- */
  const speed = knob({
    label: 'Speed', min: LIMITS.rate[0], max: LIMITS.rate[1], step: 0.01,
    format: (v) => `${v.toFixed(2)}x`, id: 'labSpeed', rest: neutral().rate
  });
  const reverb = knob({
    label: 'Reverb', min: LIMITS.reverb[0], max: LIMITS.reverb[1], step: 0.01,
    format: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`), id: 'labReverb', rest: 0
  });
  const bass = knob({
    label: 'Bass', min: LIMITS.bass[0], max: LIMITS.bass[1], step: 0.5,
    format: (v) => (v === 0 ? 'off' : signed(v)), id: 'labBass', rest: 0
  });
  const knobs = make('div', 'lab-knobs');
  knobs.append(speed.el, reverb.el, bass.el);

  const linked = make('label', 'lab-check lab-switch');
  const linkedBox = make('input');
  linkedBox.type = 'checkbox';
  linkedBox.id = 'labLinked';
  linked.append(linkedBox, make('span', '', 'Pitch follows speed'));

  const rooms = make('div', 'lab-chips lab-rooms');
  rooms.setAttribute('role', 'group');
  rooms.setAttribute('aria-label', 'Room size');
  const roomBtn = new Map();
  ROOMS.forEach((r) => {
    const b = make('button', 'lab-chip', r === 'room' ? 'Small room' : r === 'hall' ? 'Hall' : 'Cave');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => player.setLab({ room: r }));
    rooms.appendChild(b);
    roomBtn.set(r, b);
  });

  const fadeLine = make('p', 'lab-fade mono');
  const colKnobs = make('div', 'lab-col lab-col-knobs');
  colKnobs.append(knobs, linked, rooms, fadeLine);

  lab.body.append(colPresets, colEq, colKnobs);

  /* Changes are coalesced: a drag fires input many times a second and
     each one is a save. The last values win. */
  let pending = null;
  let timer = null;
  function change(patch) {
    pending = { ...(pending || {}), ...patch };
    clearTimeout(timer);
    timer = setTimeout(() => {
      const p = pending;
      pending = null;
      player.setLab(p);
    }, 30);
  }

  let snap = null;

  speed.input.addEventListener('input', () => { speed.readout(); change({ rate: Number(speed.input.value) }); });
  linkedBox.addEventListener('change', () => change({ linked: linkedBox.checked }));
  reverb.input.addEventListener('input', () => { reverb.readout(); change({ reverb: Number(reverb.input.value) }); });
  bass.input.addEventListener('input', () => { bass.readout(); change({ bass: Number(bass.input.value) }); });
  bands.forEach((b) => {
    b.input.addEventListener('input', () => {
      b.readout();
      drawCurve();
      change({ eq: bands.map((x) => Number(x.input.value)) });
    });
  });
  reset.addEventListener('click', () => player.resetLab());
  scopeSong.addEventListener('click', () => player.setLabScope('song'));
  scopeAll.addEventListener('click', () => player.setLabScope('all'));

  function render(next) {
    snap = next;
    const s = clean(next.settings);

    speed.show(s.rate);
    linkedBox.checked = s.linked;
    reverb.show(s.reverb);
    bass.show(s.bass);
    bands.forEach((b, i) => b.show(s.eq[i]));
    drawCurve();

    const active = presetFor(s);
    chipFor.forEach((b, id) => b.setAttribute('aria-pressed', String(id === active)));
    roomBtn.forEach((b, r) => {
      b.setAttribute('aria-pressed', String(r === s.room));
      b.disabled = s.reverb === 0;
    });

    scopeSong.setAttribute('aria-pressed', String(next.scope !== 'all'));
    scopeAll.setAttribute('aria-pressed', String(next.scope === 'all'));
    scopeSong.disabled = !next.track;
    scopeAll.disabled = !next.track;

    if (!next.track) note.textContent = 'Play a song to use the lab.';
    else if (next.blocked) note.textContent = next.blocked;
    else if (next.scope === 'all') note.textContent = 'These settings apply to every song.';
    else note.textContent = `Kept for ${next.track.t}.`;
    note.dataset.state = next.blocked ? 'warn' : '';

    // Reverb, bass and EQ are what need the graph
    const gated = Boolean(next.blocked);
    [reverb, bass, ...bands].forEach((c) => c.gate(gated));
  }

  player.onLab(render);

  document.addEventListener('nine:open-lab', (event) => {
    lab.toggle(event.detail && event.detail.anchor);
  });

  player.onSettings((p) => {
    fadeLine.textContent = p.crossfade > 0
      ? `Crossfade ${p.crossfade} s, set in Settings`
      : 'Crossfade off, set in Settings';
  });

  /* ================= Sleep timer ================= */
  const sleep = makePopover({ id: 'sleepPanel', title: 'Sleep timer', frame });
  sleep.el.classList.add('pop-sleep');

  const state = make('p', 'sleep-state', 'Off');
  state.setAttribute('role', 'status');
  const opts = make('div', 'sleep-opts');
  [['15 minutes', 15], ['30 minutes', 30], ['60 minutes', 60], ['End of this song', 'song']]
    .forEach(([name, how]) => {
      const b = make('button', 'btn btn-ghost sleep-opt', name);
      b.type = 'button';
      b.addEventListener('click', () => player.startSleep(how));
      opts.appendChild(b);
    });
  const off = make('button', 'btn btn-ghost sleep-off', 'Turn off');
  off.type = 'button';
  off.addEventListener('click', () => player.cancelSleep());
  sleep.body.append(state, opts);
  sleep.foot.append(
    make('span', 'sleep-hint', 'Pauses the music. Off until you pick one, and cleared when the app closes.'),
    off
  );

  function clock(sec) {
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  player.onSleep((st) => {
    if (st.mode === 'timer') state.textContent = `Pauses in ${clock(st.left)}`;
    else if (st.mode === 'song') state.textContent = 'Pauses when this song ends';
    else state.textContent = 'Off';
    off.hidden = !st.mode;
  });

  document.addEventListener('nine:open-sleep', (event) => {
    sleep.toggle(event.detail && event.detail.anchor);
  });

  return {
    lab: { open: (a) => lab.open(a), close: () => lab.close(), isOpen: () => lab.isOpen, el: lab.el },
    sleep: { open: (a) => sleep.open(a), close: () => sleep.close(), isOpen: () => sleep.isOpen, el: sleep.el },
    snapshot: () => snap
  };
}
