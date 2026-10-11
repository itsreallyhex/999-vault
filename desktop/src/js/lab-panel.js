/* ============================================================
   The sound lab and the sleep timer: two panels over the bar.

   The lab is speed and pitch, reverb, bass and a ten band equalizer,
   with a few named starting points. What is set is kept for the song,
   or for every song if the switch at the bottom says so. All of the
   audio work is in player.js and fx.js; this only draws the controls
   and says what the player said.

   The sleep timer pauses the music after 15, 30 or 60 minutes, or at
   the end of the song that is playing.

   shell.js only.
   ============================================================ */

import { make } from './utils.js';
import { makePopover } from './popover.js';
import { PRESETS, BANDS, LIMITS, ROOMS, presetFor, clean } from './fx.js';

/** "31 Hz", "1 kHz". */
function hz(n) {
  return n >= 1000 ? `${n / 1000} kHz` : `${n} Hz`;
}

function signed(db) {
  const v = Math.round(db * 10) / 10;
  return `${v > 0 ? '+' : ''}${v} dB`;
}

/** Put a range input's fill where its value is. The bar's range
    styling reads --p. */
function paint(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--p', `${pct}%`);
}

/** A labelled slider. `format` turns the number into the readout. */
function slider({ label, min, max, step, format, id }) {
  const row = make('div', 'lab-row');
  const head = make('div', 'lab-head');
  const name = make('label', 'lab-name', label);
  const out = make('span', 'lab-val mono', '');
  head.append(name, out);

  const input = make('input', 'mini-range lab-range');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.id = id;
  name.htmlFor = id;

  row.append(head, input);

  return {
    row,
    input,
    show(value) {
      // Never move the handle out from under a hand that is on it
      if (document.activeElement !== input) input.value = String(value);
      out.textContent = format(Number(value));
      paint(input);
    },
    readout() { out.textContent = format(Number(input.value)); paint(input); }
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

  const note = make('p', 'lab-note');
  note.setAttribute('role', 'status');

  const presets = make('div', 'lab-chips');
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

  const speed = slider({
    label: 'Speed', min: LIMITS.rate[0], max: LIMITS.rate[1], step: 0.01,
    format: (v) => `${v.toFixed(2)}x`, id: 'labSpeed'
  });
  const linked = make('label', 'lab-check');
  const linkedBox = make('input');
  linkedBox.type = 'checkbox';
  linkedBox.id = 'labLinked';
  linked.append(linkedBox, make('span', '', 'Pitch follows speed (slowed goes lower, sped up goes higher)'));

  const reverb = slider({
    label: 'Reverb', min: LIMITS.reverb[0], max: LIMITS.reverb[1], step: 0.01,
    format: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`), id: 'labReverb'
  });
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

  const bass = slider({
    label: 'Bass boost', min: LIMITS.bass[0], max: LIMITS.bass[1], step: 0.5,
    format: (v) => (v === 0 ? 'off' : signed(v)), id: 'labBass'
  });

  const eqWrap = make('div', 'lab-eq');
  eqWrap.appendChild(make('p', 'lab-sub', 'Equalizer'));
  const eqGrid = make('div', 'lab-eq-grid');
  const bands = BANDS.map((f, i) => {
    const s = slider({
      label: hz(f), min: LIMITS.eq[0], max: LIMITS.eq[1], step: 0.5,
      format: signed, id: `labEq${i}`
    });
    s.row.classList.add('lab-band');
    eqGrid.appendChild(s.row);
    return s;
  });
  eqWrap.appendChild(eqGrid);

  lab.body.append(note, presets, speed.row, linked, reverb.row, rooms, bass.row, eqWrap);

  const scopeLabel = make('label', 'lab-check');
  const scopeBox = make('input');
  scopeBox.type = 'checkbox';
  scopeBox.id = 'labScope';
  scopeLabel.append(scopeBox, make('span', '', 'Use for every song'));
  const reset = make('button', 'btn btn-ghost', 'Reset');
  reset.type = 'button';
  const fadeLine = make('p', 'lab-fade mono');
  lab.foot.append(scopeLabel, reset, fadeLine);

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
  bands.forEach((s) => {
    s.input.addEventListener('input', () => {
      s.readout();
      change({ eq: bands.map((b) => Number(b.input.value)) });
    });
  });
  reset.addEventListener('click', () => player.resetLab());
  scopeBox.addEventListener('change', () => player.setLabScope(scopeBox.checked ? 'all' : 'song'));

  function render(next) {
    snap = next;
    const s = clean(next.settings);

    speed.show(s.rate);
    linkedBox.checked = s.linked;
    reverb.show(s.reverb);
    bass.show(s.bass);
    bands.forEach((b, i) => b.show(s.eq[i]));

    const active = presetFor(s);
    chipFor.forEach((b, id) => b.setAttribute('aria-pressed', String(id === active)));
    roomBtn.forEach((b, r) => {
      b.setAttribute('aria-pressed', String(r === s.room));
      b.disabled = s.reverb === 0;
    });

    scopeBox.checked = next.scope === 'all';
    scopeBox.disabled = !next.track;

    if (!next.track) note.textContent = 'Play a song to use the lab.';
    else if (next.blocked) note.textContent = next.blocked;
    else if (next.scope === 'all') note.textContent = 'These settings apply to every song.';
    else note.textContent = `Kept for ${next.track.t}.`;
    note.dataset.state = next.blocked ? 'warn' : '';

    // Reverb, bass and EQ are what need the graph
    const gated = Boolean(next.blocked);
    [reverb.input, bass.input, ...bands.map((b) => b.input)].forEach((i) => { i.disabled = gated; });
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
