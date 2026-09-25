// Glue: wires the two BLE devices, the controller and the recorder to the UI.

import { Bike, HeartStrap, describeError } from './ble.js?v=5bff2d4';
import { levelForPower, powerFor, speedForPower, MAX_LEVEL } from './fitshow.js?v=5bff2d4';
import { HrController, Workout, FreeRide, parseWorkout, validateZones, LevelPicker,
         isConsoleReset }
  from './control.js?v=5bff2d4';
import { Recorder, offerFile } from './record.js?v=5bff2d4';
import * as icu from './icu.js?v=5bff2d4';
import { Riders } from './rider.js?v=5bff2d4';

const $ = (id) => document.getElementById(id);

// Wer faehrt. Zonen, Belastungsgrenze, Referenzleistung und der
// intervals.icu-Schluessel haengen daran; alles Weitere in rider.js.
const riders = new Riders();

const bike = new Bike();
const strap = new HeartStrap();
const rec = new Recorder();
let ctl = new HrController();
let picker = new LevelPicker();
let workout = null;
let free = null;               // offene Fahrt mit direkt gewaehlter Stufe
let sessionRiderId = null;     // Profil, aus dessen Werten die Sitzung entstand
let sessionActivity = 'Fahrt'; // bleibt beim Start an der Aufzeichnung haengen

// Die Trainingsarten schliessen einander aus; geladen ist immer hoechstens
// eine Sitzung.
const session = () => workout ?? free;
function clearSession() {
  workout = null; free = null;
  sessionRiderId = null; sessionActivity = 'Fahrt';
}
let pausedByDropout = null;     // null | 'bike' | 'hr'
// The console can crash while its Bluetooth module keeps answering: valid
// frames, correct checksums, but every value frozen. Without this check the
// app would happily record zeros for a whole session.
const stall = { seconds: null, since: 0, warned: false, frozen: false };

// The console's counters restart from zero when it reboots - which it did
// once today. Carrying an offset keeps distance and calories monotonic, so
// an export never runs backwards.
const carry = { metres: 0, kcal: 0, lastRawM: 0, lastRawK: 0 };

const live = { rpm: 0, watts: 0, level: 0, speedKmh: 0 };
const cumul = { seconds: 0, metres: 0, kcal: 0 };
// Strecke aus der Leistung statt aus dem Zaehler der Konsole (fitshow.js).
let flatMetres = 0;
let lastLevel = 0;
let hr = null, hrAt = 0;
let rpmSmooth = 0;
let lastSegIndex = -1;

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Die Oberflaeche ist deutsch; ihre Zahlen waren es nicht. Ein Komma kostet
// nichts und erspart beim Blick im Tritt das Umdenken.
const de = (v, digits = 1) => Number(v).toFixed(digits).replace('.', ',');

// Mirror everything to the development server so a second pair of eyes can
// follow along. Only where such a server exists: on static hosting this
// would be a failing request every two seconds for nothing.
const LOGGING = location.hostname === 'localhost'
             || location.hostname === '127.0.0.1'
             || new URLSearchParams(location.search).has('log');
const remote = [];
function toRemote(obj) {
  if (!LOGGING) return;
  remote.push(JSON.stringify(obj));
  if (remote.length > 400) remote.splice(0, remote.length - 400);
}
if (LOGGING) {
  setInterval(() => {
    if (!remote.length) return;
    const body = remote.splice(0, remote.length).join('\n');
    fetch('/log', { method: 'POST', body }).catch(() => {});
  }, 2000);
}

// --- log -----------------------------------------------------------------

// Every frame lands here, several times a second. Kept as a capped list and
// only drawn while the profile sheet is open: an ever-growing string
// re-rendered on each frame slows a tablet down within the hour.
const LOG_MAX = 600;
const logLines = [];

function log(kind, bytes, dec) {
  const hex = bytes ? [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ') : '';
  const t = new Date().toLocaleTimeString('de-DE');
  const extra = dec ? '  ' + JSON.stringify(dec) : '';
  logLines.push(`${t} ${kind} ${hex}${extra}`);
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  if ($('sheet-profile').open) renderLog();
  toRemote({ ev: kind, hex, dec });
}

function renderLog() {
  const el = $('log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

// On a tablet there is no console and no log server, so the log has to be
// able to leave the device by itself.
function logContext() {
  return [
    `Zeit:    ${new Date().toISOString()}`,
    `Browser: ${navigator.userAgent}`,
    `Rad:     verbunden=${bike.connected} tx=${bike.tx} rx=${bike.rx} `
      + `uebersprungen=${bike.skipped} Takt=${bike.interval}ms `
      + `Fehler=${bike.lastError ?? 'keiner'}`,
    `Gurt:    verbunden=${strap.connected} letzter Puls=${hr ?? '-'}`,
    `Live:    rpm=${live.rpm} W=${live.watts} Stufe=${live.level}`,
    `Summen:  ${cumul.seconds}s ${cumul.metres}m ${cumul.kcal}kcal`,
    '',
    ...logLines,
  ].join('\n');
}

$('btn-log-share').onclick = async () => {
  const how = await offerFile(`log-${Date.now()}.txt`, logContext(),
                              'text/plain');
  $('log-msg').textContent = how;
};
$('btn-log-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(logContext());
    $('log-msg').textContent = 'in die Zwischenablage kopiert';
  } catch (e) {
    $('log-msg').textContent = 'Kopieren ging nicht — Text markieren';
  }
};
$('btn-log-clear').onclick = () => {
  logLines.length = 0;
  renderLog();
  $('log-msg').textContent = '';
};

// --- banner --------------------------------------------------------------

// Things the rider has to act on. Several can be pending; errors win.
const banners = new Map();
function setBanner(key, text, kind = 'warn') {
  const had = banners.get(key);
  if (text) {
    if (had?.text === text && had.kind === kind) return;
    banners.set(key, { text, kind });
  } else {
    if (!had) return;
    banners.delete(key);
  }
  const list = [...banners.values()];
  const el = $('banner');
  el.hidden = !list.length;
  if (!list.length) return;
  // Es gibt nur einen Platz. Fehler gehen vor, sonst gilt die juengste
  // Meldung — sonst verdeckt ein alter Hinweis das frische "Rad getrennt".
  const top = list.find(b => b.kind === 'err') ?? list[list.length - 1];
  el.textContent = top.text;
  el.className = 'banner ' + top.kind;
}

// --- sheets --------------------------------------------------------------

function openSheet(id) {
  const d = $(id);
  if (d.open) return;
  if (d.showModal) d.showModal(); else d.setAttribute('open', '');
}
function closeSheet(id) {
  const d = $(id);
  if (!d.open) return;
  if (d.close) d.close(); else d.removeAttribute('open');
}
// A tap beside a sheet closes it; the sheet itself fills its dialog.
for (const d of document.querySelectorAll('dialog.sheet')) {
  d.addEventListener('click', (e) => { if (e.target === d) closeSheet(d.id); });
}

$('chip-bike').onclick = () => openSheet('sheet-devices');
$('chip-hr').onclick = () => openSheet('sheet-devices');
$('btn-profile').onclick = () => { renderLog(); openSheet('sheet-profile'); };
$('btn-plan').onclick = () => { previewPlan(); openSheet('sheet-plan'); };
$('btn-replan').onclick = () => { previewPlan(); openSheet('sheet-plan'); };
$('btn-to-profile').onclick = () => {
  closeSheet('sheet-plan'); renderLog(); openSheet('sheet-profile');
};
// Zones edited in the profile show up in the training form at once.
$('sheet-profile').addEventListener('close', () => { drawZoneTrack(); previewPlan(); });

// --- Fahrer --------------------------------------------------------------

// Der Name steht in der Kopfleiste neben Rad und Gurt: „wer faehrt“ ist
// dieselbe Art Vorbedingung wie „was ist verbunden“, und der Fehlerfall ist
// das Vergessen. Ein falsches Profil faellt so in den ersten Sekunden auf und
// nicht erst beim Hochladen.
function renderRiderChip() {
  $('chip-rider-name').textContent = riders.name();
  $('chip-rider').title = `Fahrer: ${riders.name()}`;
  $('prof-rider').textContent = riders.name();
}

// Zwei Tipp auf den Loeschknopf: ein Profil nimmt seine Zonen mit, und ein
// Fehlgriff waere nicht rueckgaengig zu machen.
let armed = null;
let armTimer = 0;
function disarm() { clearTimeout(armTimer); armed = null; }

function renderRiders() {
  const list = $('rider-list');
  const all = riders.list();
  const locked = !!session()?.running || isUnderway();
  const recordingOwner = rec.samples.length ? rec.meta?.riderId : null;
  list.textContent = '';

  for (const r of all) {
    const active = r.id === riders.activeId();
    const row = document.createElement('div');
    row.className = 'rider-row';
    row.dataset.active = active ? '1' : '';
    const add = (el) => { row.appendChild(el); return el; };

    add(document.createElement('span')).className = 'rider-dot';

    const name = add(document.createElement('input'));
    name.type = 'text';
    name.maxLength = 24;
    name.value = r.name;
    name.setAttribute('aria-label', 'Name');
    name.oninput = () => { riders.rename(r.id, name.value); renderRiderChip(); };

    if (active) {
      const here = add(document.createElement('span'));
      here.className = 'rider-here';
      here.textContent = 'fährt';
    } else {
      const use = add(document.createElement('button'));
      use.className = 'btn sm';
      use.textContent = 'Wechseln';
      use.disabled = locked;
      use.onclick = () => { disarm(); riders.use(r.id); applyRider(); };
    }

    const del = add(document.createElement('button'));
    del.className = 'icon-btn';
    del.textContent = '×';
    del.setAttribute('aria-label', `${r.name} löschen`);
    del.hidden = all.length < 2;
    del.disabled = (locked && active) || recordingOwner === r.id;
    del.dataset.armed = armed === r.id ? '1' : '';
    del.onclick = () => {
      if (armed !== r.id) {
        disarm();
        armed = r.id;
        armTimer = setTimeout(() => { disarm(); renderRiders(); }, 6000);
        renderRiders();
        return;
      }
      disarm();
      riders.remove(r.id);
      applyRider();
    };

    list.appendChild(row);
  }

  const armedName = all.find(r => r.id === armed)?.name;
  const ownerName = all.find(r => r.id === recordingOwner)?.name;
  $('rider-msg').textContent =
    locked ? 'Während der Fahrt wird nicht gewechselt.'
    : armedName ? `${armedName} samt Zonen löschen? Noch einmal tippen.`
    : ownerName ? `Die aufgezeichnete Fahrt gehört ${ownerName}; das Profil bleibt bis zur nächsten Fahrt erhalten.`
    : '';
  $('rider-msg').className = armedName ? 'msg err' : 'msg';
  $('rider-add').disabled = locked;
}

// Nach einem Wechsel muss jede Zahl, die am Fahrer haengt, neu gelesen
// werden — sonst faehrt der naechste Mensch mit den Zonen des vorigen.
function applyRider() {
  // Eine nur geladene Sitzung enthaelt bereits konkrete Zonen bzw. ein
  // konkretes Gewicht. Nach dem Fahrerwechsel muss sie neu geladen werden;
  // die fertige Aufzeichnung darunter bleibt mit ihren Metadaten erhalten.
  if (sessionRiderId && sessionRiderId !== riders.activeId()) clearSession();
  zones = loadZones();
  syncProfileNumbers();
  $('icu-key').value = icuKey();
  renderZones();
  fillZoneSelects();
  checkZones();
  drawZoneTrack();
  previewPlan();
  renderRiders();
  renderRiderChip();
  renderSegment();
  refreshButtons();
}

$('chip-rider').onclick = () => { disarm(); renderRiders(); openSheet('sheet-rider'); };
$('btn-rider').onclick = () => {
  closeSheet('sheet-profile');
  disarm(); renderRiders(); openSheet('sheet-rider');
};
// Ein leeres Namensfeld ist kein Fehler: rider.js vergibt dann einen Namen.
$('rider-add').onclick = () => {
  if (session()?.running || isUnderway()) return;
  disarm();
  riders.add($('rider-name').value);
  $('rider-name').value = '';
  applyRider();
};
$('rider-name').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('rider-add').click(); }
};
$('sheet-rider').addEventListener('close', () => {
  disarm();
  drawZoneTrack();
  previewPlan();
});

// --- device wiring -------------------------------------------------------

function setDevice(key, state, detail) {
  const chip = $(`chip-${key}`);
  if (chip.dataset.state === state && $(`dev-${key}-state`).textContent === detail)
    return;
  chip.dataset.state = state;           // off | busy | on | err
  chip.title = detail;
  $(`dev-${key}`).dataset.state = state;
  $(`dev-${key}-state`).textContent = detail;
  $(`btn-${key}`).textContent = state === 'on' ? 'Neu verbinden' : 'Verbinden';
  $(`btn-${key}`).className = state === 'on' ? 'btn' : 'btn primary';
}

function closeDevicesWhenDone() {
  if (bike.connected && strap.connected)
    setTimeout(() => closeSheet('sheet-devices'), 900);
}

bike.onLog = log;
bike.onLive = (d) => { Object.assign(live, d); };
bike.onCumul = (d) => {
  // Nur eine *veraenderte* Laufzeit entlastet die Konsole wieder. Vorher hob
  // das Anhalten die Bedingung auf, unter der es angehalten hatte: die
  // Warnung stand eine Sekunde und war weg, die Uhr blieb ohne Grund stehen.
  if (d.seconds !== stall.seconds) {
    stall.seconds = d.seconds; stall.since = 0;
    stall.warned = false; stall.frozen = false;
  } else if (!!session()?.running && live.rpm >= 20) {
    stall.since ||= Date.now();
  }

  if (d.metres < carry.lastRawM) carry.metres += carry.lastRawM;
  if (d.kcal < carry.lastRawK) carry.kcal += carry.lastRawK;
  carry.lastRawM = d.metres;
  carry.lastRawK = d.kcal;

  cumul.seconds = d.seconds;
  cumul.metres = carry.metres + d.metres;
  cumul.kcal = carry.kcal + d.kcal;
};
bike.onState = (s) => {
  if (s === 'connected') {
    setDevice('bike', 'on', 'verbunden');
    bike.startPolling();
    closeDevicesWhenDone();
  } else if (s === 'lost') {
    setDevice('bike', 'err', 'Verbindung verloren');
  } else {
    setDevice('bike', 'busy', 'getrennt — verbinde wieder …');
  }
  setBanner('bike-lost', s === 'lost'
    ? 'Verbindung zum Rad verloren — oben auf „Rad" tippen und neu verbinden.'
    : null, 'err');
  refreshButtons();
};

strap.onLog = log;
strap.onHr = (r) => { hr = r.bpm; hrAt = Date.now(); ctl.pushHr(r.bpm); };
strap.onState = (s) => {
  if (s === 'connected') {
    setDevice('hr', 'on', 'verbunden');
    closeDevicesWhenDone();
  } else if (s === 'lost') {
    setDevice('hr', 'err', 'Verbindung verloren');
  } else {
    setDevice('hr', 'busy', 'getrennt — verbinde wieder …');
  }
  setBanner('hr-lost', s === 'lost'
    ? 'Verbindung zum Pulsgurt verloren — oben auf „Gurt" tippen und neu verbinden.'
    : null, 'err');
  refreshButtons();
};

async function connectDevice(which, dev, key) {
  if (!navigator.bluetooth) { setDevice(key, 'err', 'kein Web Bluetooth'); return; }
  const any = $('show-all').checked;
  log(`verbinde ${which}${any ? ' (alle Geräte)' : ''} ...`);
  toRemote({ ev: 'connect-start', which, any });
  const wasOn = dev.connected;
  setDevice(key, 'busy', 'suche …');
  try {
    await dev.connect({ any });
    if (which === 'bike') await dev.start();
    toRemote({ ev: 'connect-ok', which });
  } catch (e) {
    // On a tablet there is no console, so the failure has to be readable in
    // the page itself - and not every implementation rejects with an Error.
    const text = describeError(e);
    log(`verbinden fehlgeschlagen: ${text}`);
    toRemote({ ev: 'connect-error', which, text });
    if (e && e.name === 'NotFoundError')
      setDevice(key, wasOn && dev.connected ? 'on' : 'off',
                wasOn && dev.connected ? 'verbunden'
                  : 'nichts ausgewählt oder nichts gefunden');
    else setDevice(key, 'err', text.slice(0, 90));
  }
}

$('btn-bike').onclick = () => connectDevice('bike', bike, 'bike');
$('btn-hr').onclick = () => connectDevice('strap', strap, 'hr');

// --- zones ---------------------------------------------------------------

// Entered by hand on purpose: zone maths differs per method and per person,
// so the app stores what the rider decides rather than inventing it. The
// optional load limit is deliberately separate: a training zone is not a
// medical or personal ceiling.
const DEFAULT_ZONES = [
  { name: 'Regeneration', lo: null, hi: null },
  { name: 'Grundlage 1', lo: null, hi: null },
  { name: 'Grundlage 2', lo: null, hi: null },
  { name: 'Schwelle', lo: null, hi: null },
  { name: 'Entwicklung', lo: null, hi: null },
];
const ZONE_COLORS = ['var(--z1)', 'var(--z2)', 'var(--z3)',
                     'var(--z4)', 'var(--z5)', 'var(--z6)'];

function loadZones() {
  const value = riders.get('zones');
  if (Array.isArray(value)) return value.filter(z => z && typeof z === 'object')
    .map(z => ({ name: String(z.name ?? ''),
                lo: Number.isFinite(z.lo) ? z.lo : null,
                hi: Number.isFinite(z.hi) ? z.hi : null }));
  return DEFAULT_ZONES.map(z => ({ ...z }));
}
function saveZones() {
  if (!riders.set('zones', zones))
    $('zone-msg').textContent = 'konnte nicht gespeichert werden';
}

let zones = loadZones();
const zoneReady = (z) => String(z.name ?? '').trim()
  && Number.isFinite(z.lo) && Number.isFinite(z.hi)
  && z.lo >= 60 && z.hi <= 220 && z.hi >= z.lo;
const colorOf = (z) => ZONE_COLORS[Math.max(0, zones.indexOf(z)) % ZONE_COLORS.length];

function optionalProfileNumber(field, lo, hi) {
  const value = riders.get(field);
  return Number.isFinite(value) && value >= lo && value <= hi ? value : null;
}

function hrCeiling() { return optionalProfileNumber('hrLimit', 80, 220); }
function referencePower() { return optionalProfileNumber('refPower', 40, 400); }

function syncProfileNumbers() {
  $('hr-limit').value = hrCeiling() ?? '';
  $('ref-power').value = referencePower() ?? '';
  renderReference();
}

function refreshProfileLock() {
  const locked = !!session()?.running || isUnderway();
  for (const id of ['hr-limit', 'ref-power', 'zone-add']) $(id).disabled = locked;
  for (const el of $('zone-rows').querySelectorAll('input, button')) el.disabled = locked;
}

function bindProfileNumber(id, field, lo, hi) {
  const el = $(id);
  el.onchange = () => {
    const raw = el.value.trim();
    if (!raw) { riders.set(field, null); el.value = ''; }
    else {
      const value = clamp(Math.round(Number(raw) || lo), lo, hi);
      el.value = value;
      riders.set(field, value);
    }
    checkZones();
    renderReference();
    refreshButtons();
  };
}
bindProfileNumber('hr-limit', 'hrLimit', 80, 220);
bindProfileNumber('ref-power', 'refPower', 40, 400);
syncProfileNumbers();

function zonesChanged() {
  saveZones(); fillZoneSelects(); checkZones(); drawZoneTrack();
  // Ein schon gebauter Plan enthaelt Kopien der alten Grenzen. Nach einer
  // Aenderung muss er sichtbar neu geladen werden statt still alt zu bleiben.
  if (session() && !session()?.running && !isUnderway()) {
    clearSession(); renderSegment(); refreshButtons();
  }
}

function renderZones() {
  const body = $('zone-rows');
  body.textContent = '';
  zones.forEach((z, i) => {
    const row = document.createElement('div');
    row.className = 'zone-row';
    row.style.setProperty('--c', colorOf(z));
    const add = (el) => { row.appendChild(el); return el; };

    add(document.createElement('span')).className = 'zone-swatch';

    const name = add(document.createElement('input'));
    name.type = 'text';
    name.value = z.name ?? '';
    name.placeholder = 'Name';
    name.setAttribute('aria-label', 'Name der Zone');
    name.oninput = () => { z.name = name.value; zonesChanged(); };

    for (const key of ['lo', 'hi']) {
      const inp = add(document.createElement('input'));
      inp.type = 'number'; inp.inputMode = 'numeric';
      inp.min = 60; inp.max = 220;
      inp.value = z[key] ?? '';
      inp.placeholder = 'bpm';
      inp.setAttribute('aria-label', key === 'lo' ? 'von' : 'bis');
      inp.oninput = () => {
        const v = parseInt(inp.value, 10);
        z[key] = Number.isFinite(v) ? v : null;
        zonesChanged();
      };
    }

    const del = add(document.createElement('button'));
    del.className = 'icon-btn';
    del.textContent = '×';
    del.title = 'Zone entfernen';
    del.setAttribute('aria-label', 'Zone entfernen');
    del.onclick = () => { zones.splice(i, 1); renderZones(); zonesChanged(); };
    body.appendChild(row);
  });
  checkZones();
}

function zoneProblems() {
  return validateZones(zones);
}

function checkZones() {
  const ready = zones.filter(zoneReady).length;
  const problems = zoneProblems();
  $('zone-msg').textContent = problems.length
    ? problems[0]
    : ready
      ? `${ready} von ${zones.length} einsatzbereit`
      : 'Noch keine Zone ausgefüllt';
  $('zone-msg').className = 'msg' + (problems.length ? ' err' : ready ? ' ok' : '');
  // Das freie Training braucht keine Pulszonen — der Hinweis stand dort als
  // Mahnung fuer etwas, das gar nicht gebraucht wird.
  //
  // Und: ein Zonenfehler sperrt das Laden, stand aber nur als rote Zeile im
  // Ablauf — ohne zu sagen, wo er zu beheben ist. Der Kasten sagt es jetzt
  // und bringt einen hin.
  const needsZones = program !== 'free';
  const trouble = !ready
    ? 'Noch keine Pulszone ausgefüllt. Die Zonen stehen im Profil.'
    : problems.length ? `${problems[0]} Zu ändern im Profil.` : null;
  $('plan-nozones').hidden = !needsZones || !trouble;
  if (trouble) $('plan-zone-trouble').textContent = trouble;
  return ready > 0 && !problems.length;
}

/** The heart rate scale of the zone bar: the zones plus a little air. */
function hrRange() {
  const ready = zones.filter(zoneReady);
  if (!ready.length) return [60, 190];
  return [Math.max(40, Math.min(...ready.map(z => z.lo)) - 10),
          Math.max(...ready.map(z => z.hi)) + 10];
}
function hrPos(v) {
  const [a, b] = hrRange();
  return clamp(((v - a) / (b - a)) * 100, 0, 100);
}

function drawZoneTrack() {
  const track = $('zonebar-track');
  track.textContent = '';
  for (const z of zones) {
    if (!zoneReady(z)) continue;
    const el = document.createElement('i');
    el.style.left = hrPos(z.lo) + '%';
    el.style.width = Math.max(0.5, hrPos(z.hi + 1) - hrPos(z.lo)) + '%';
    el.style.background = colorOf(z);
    track.appendChild(el);
  }
}

/** The highest zone the heart rate sits in, if any. */
function zoneAt(bpm) {
  let hit = null;
  for (const z of zones) if (zoneReady(z) && bpm >= z.lo && bpm <= z.hi) hit = z;
  return hit;
}

const ZONE_SELECTS = ['z-zone', 'z-warmzone', 'z-coolzone',
                      'i-workzone', 'i-restzone', 'i-warmzone', 'i-coolzone'];

function fillZoneSelects() {
  const usable = zones.filter(zoneReady);
  for (const id of ZONE_SELECTS) {
    const sel = $(id);
    if (!sel) continue;
    const before = sel.value;
    sel.textContent = '';
    usable.forEach((z) => {
      const o = document.createElement('option');
      o.value = z.name;
      o.textContent = `${z.name} (${z.lo}–${z.hi})`;
      sel.appendChild(o);
    });
    if (usable.some(z => z.name === before)) sel.value = before;
  }
  presetZoneSelects(usable);
}

// Sensible starting picks so the forms are usable straight away.
function presetZoneSelects(usable) {
  if (!usable.length) return;
  const pick = (id, idx) => {
    const sel = $(id);
    if (sel && !sel.dataset.touched)
      sel.value = usable[Math.min(idx, usable.length - 1)].name;
  };
  pick('z-zone', 1); pick('z-warmzone', 0); pick('z-coolzone', 0);
  pick('i-workzone', 3); pick('i-restzone', 0);
  pick('i-warmzone', 0); pick('i-coolzone', 0);
}
for (const id of ZONE_SELECTS) {
  const sel = $(id);
  if (sel) sel.addEventListener('change', () => { sel.dataset.touched = '1'; });
}

for (const kind of ['work', 'rest']) {
  const sel = $(`i-${kind}mode`);
  const sync = () => {
    $(`wrap-i-${kind}w`).hidden = sel.value !== 'watt';
    $(`wrap-i-${kind}zone`).hidden = sel.value !== 'zone';
  };
  sel.onchange = sync;
  sync();
}

function renderReference() {
  const ref = referencePower();
  $('i-ref-fill').disabled = !ref;
  $('i-ref-note').textContent = ref
    ? `Referenz ${ref} W · Vorschlag ${Math.round(ref * 1.05 / 5) * 5} / ${Math.round(ref * 0.5 / 5) * 5} W`
    : 'Referenzleistung im Profil eintragen oder Wattwerte selbst setzen.';
}
$('i-ref-fill').onclick = () => {
  const ref = referencePower();
  if (!ref) return;
  $('i-workw').value = clamp(Math.round(ref * 1.05 / 5) * 5, 30, 400);
  $('i-restw').value = clamp(Math.round(ref * 0.5 / 5) * 5, 25, 250);
  planFormChanged();
};
renderReference();

$('zone-add').onclick = () => {
  zones.push({ name: `Zone ${zones.length + 1}`, lo: null, hi: null });
  renderZones(); zonesChanged();
};

// --- programs ------------------------------------------------------------

// ?prog=interval preselects a tab - handy for a bookmark, and it lets the
// layout be checked in a headless browser without clicking.
const askedProg = new URLSearchParams(location.search).get('prog');
let program = ['interval', 'free'].includes(askedProg) ? askedProg : 'zone';

function selectProgram(p) {
  program = p;
  if (session() && !session()?.running && !isUnderway()) {
    clearSession(); renderSegment(); refreshButtons();
  }
  for (const b of document.querySelectorAll('.tab'))
    b.setAttribute('aria-selected', String(b.dataset.prog === p));
  $('prog-zone').hidden = program !== 'zone';
  $('prog-interval').hidden = program !== 'interval';
  $('prog-free').hidden = program !== 'free';
  // Der Zonenhinweis haengt am Programm, nicht nur an den Zonen: beim
  // Reiterwechsel muss er neu bewertet werden, sonst bleibt er stehen oder
  // weg, je nachdem, womit die Seite geladen wurde.
  checkZones();
  previewPlan();
}
for (const btn of document.querySelectorAll('.tab'))
  btn.onclick = () => selectProgram(btn.dataset.prog);

const byName = (n) => zones.find(z => z.name === n && zoneReady(z));

function fieldNumber(id, label, lo, hi, { integer = false } = {}) {
  const raw = $(id).value.trim();
  if (!raw) throw new Error(`${label} fehlt`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < lo || value > hi)
    throw new Error(`${label} muss zwischen ${lo} und ${hi} liegen`);
  if (integer && !Number.isInteger(value))
    throw new Error(`${label} muss eine ganze Zahl sein`);
  return value;
}

const optionalMinutes = (id, label) => fieldNumber(id, label, 0, 60);

function seg(minutes, zoneName, label) {
  if (minutes <= 0) return [];          // skipped sections need no zone
  const z = byName(zoneName);
  if (!z) throw new Error(`Für „${label}" ist keine Pulszone ausgefüllt`);
  return [`${minutes}min@${z.lo}-${z.hi} ${label}`];
}

function buildPlan() {
  const lines = [];
  const problems = zoneProblems();
  if (problems.length) throw new Error(problems[0]);
  if (program === 'zone') {
    lines.push(...seg(optionalMinutes('z-warm', 'Einfahrdauer'), $('z-warmzone').value, 'Einfahren'));
    lines.push(...seg(fieldNumber('z-min', 'Dauer', 1, 240), $('z-zone').value, $('z-zone').value));
    lines.push(...seg(optionalMinutes('z-cool', 'Ausfahrdauer'), $('z-coolzone').value, 'Ausfahren'));
  } else {
    const count = fieldNumber('i-count', 'Anzahl', 1, 30, { integer: true });
    lines.push(...seg(optionalMinutes('i-warm', 'Einfahrdauer'), $('i-warmzone').value, 'Einfahren'));
    const part = (kind, label) => {
      const mins = fieldNumber(`i-${kind}`, `${label}sdauer`, 0.5, 60);
      return $(`i-${kind}mode`).value === 'watt'
        ? [`${mins}min@${fieldNumber(`i-${kind}w`, `${label}sleistung`,
              kind === 'work' ? 30 : 25, kind === 'work' ? 400 : 250)}W ${label}`]
        : seg(mins, $(`i-${kind}zone`).value, label);
    };
    const work = part('work', 'Belastung');
    const rest = part('rest', 'Erholung');
    if (!work.length) throw new Error('Die Belastung braucht eine Dauer');
    for (let i = 1; i <= count; i++) {
      lines.push(work[0].replace('Belastung', `Belastung ${i}/${count}`));
      if (rest.length && i < count) lines.push(rest[0]);
    }
    lines.push(...seg(optionalMinutes('i-cool', 'Ausfahrdauer'), $('i-coolzone').value, 'Ausfahren'));
  }
  if (!lines.length) throw new Error('Das Programm ist leer');
  return lines.join('\n');
}

const segTarget = (s) => s.watts ? `${s.watts} W`
  : (s.hrHi > s.hrLo ? `${s.hrLo}–${s.hrHi} bpm` : `${s.hrTarget} bpm`);

/** Bar colour: the rider's own zone colour, or violet for watt sections. */
function segColor(s) {
  if (s.watts) return 'var(--watt)';
  const z = zones.find(z => zoneReady(z) && z.lo === s.hrLo && z.hi === s.hrHi)
         ?? zoneAt(s.hrTarget);
  return z ? colorOf(z) : 'var(--muted)';
}

function segHeight(s, segs) {
  if (s.watts) {
    const top = Math.max(200, ...segs.filter(x => x.watts).map(x => x.watts));
    return clamp(s.watts / top, 0, 1);
  }
  return hrPos(s.hrTarget) / 100;
}

function drawTimeline(el, segs) {
  el.textContent = '';
  for (const s of segs) {
    const b = document.createElement('i');
    b.style.flexGrow = s.seconds;
    b.style.height = `${Math.round(22 + 78 * segHeight(s, segs))}%`;
    b.style.background = segColor(s);
    b.title = `${fmtTime(s.seconds)} ${s.label} — ${segTarget(s)}`;
    el.appendChild(b);
  }
}

function planWarnings() {
  if (program !== 'interval') return [];
  const warnings = [];
  for (const [kind, label] of [['work', 'Belastung'], ['rest', 'Erholung']]) {
    const minutes = Number($(`i-${kind}`).value);
    if ($(`i-${kind}mode`).value === 'zone' && minutes < 3)
      warnings.push(`${label} unter 3 min ist zu kurz für eine Pulsregelung`);
    if ($(`i-${kind}mode`).value === 'watt') {
      const watts = Number($(`i-${kind}w`).value);
      if (Number.isFinite(watts) && watts > 0) {
        const need = levelForPower(watts, 80);
        if (need > MAX_LEVEL)
          warnings.push(`${watts} W sind bei 80 rpm nicht erreichbar (Bedarf Stufe ${de(need, 1)})`);
        else if (need < 1)
          warnings.push(`${watts} W liegen bei 80 rpm unter Stufe 1`);
      }
    }
  }
  return warnings;
}

/** Parse the form as it stands, so the rider sees the ride before loading it. */
function previewPlan() {
  const msg = $('workout-msg');
  if (program === 'free') {
    $('plan-preview').hidden = true;
    $('btn-load').textContent = 'Freies Training laden';
    $('plan-timeline').textContent = '';
    $('btn-load').disabled = false;
    return null;
  }
  $('plan-preview').hidden = false;
  $('btn-load').textContent = 'Training laden';
  try {
    const segs = parseWorkout(buildPlan());
    const secs = segs.reduce((a, s) => a + s.seconds, 0);
    const warnings = planWarnings();
    msg.textContent = `${segs.length} Abschnitte · ${Math.round(secs / 60)} min`
      + (warnings.length ? ` · Achtung: ${warnings.join('; ')}` : '');
    msg.className = 'msg' + (warnings.length ? ' warn' : '');
    drawTimeline($('plan-timeline'), segs);
    $('workout-preview').textContent = segs
      .map(s => `${Math.round(s.seconds / 60)} min ${s.label} ${segTarget(s)}`)
      .join('  ·  ');
    $('btn-load').disabled = false;
    return segs;
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
    $('plan-timeline').textContent = '';
    $('workout-preview').textContent = '';
    $('btn-load').disabled = true;
    return null;
  }
}
function planFormChanged() {
  // Vorschau und geladene Sitzung duerfen nie verschiedene Konfigurationen
  // zeigen. Eine Aenderung vor dem Start verlangt deshalb erneutes Laden.
  if (session() && !session()?.running && !isUnderway()) {
    clearSession(); renderSegment(); refreshButtons();
  }
  previewPlan();
}
$('sheet-plan').addEventListener('input', planFormChanged);
$('sheet-plan').addEventListener('change', planFormChanged);

$('btn-load').onclick = async () => {
  if (program === 'free') {
    free = new FreeRide(live.level || 1);
    workout = null;
    sessionRiderId = riders.activeId();
    sessionActivity = 'Freies Training';
    syncFreeLevel(free.level);
    closeSheet('sheet-plan');
    renderSegment();
    refreshButtons();
    return;
  }
  const segs = previewPlan();
  if (!segs) return;
  workout = new Workout(segs);
  free = null;
  lastSegIndex = -1;
  sessionRiderId = riders.activeId();
  sessionActivity = program === 'interval' ? 'Intervalltraining' : 'Zielzonentraining';
  closeSheet('sheet-plan');
  renderSegment();
  refreshButtons();
};

// --- session controls ----------------------------------------------------

const isUnderway = () => free ? free.underway
  : (!!workout && !workout.done
     && (workout.index > 0 || workout.elapsedInSeg > 0));
const workoutNeedsHr = () => !!workout
  && (workout.segments.some(s => !s.watts) || hrCeiling() != null);
const hrIsFresh = () => hr != null && Date.now() - hrAt < 12000;
const recordingMeta = () => ({ riderId: riders.activeId(),
  riderName: riders.name(), activity: sessionActivity });

$('btn-start').onclick = () => {
  if (!session()) return;
  // Sollte ein Wechsel aus einem alten Browserzustand doch an der UI-Sperre
  // vorbeikommen, startet nie eine Sitzung mit fremden Profilwerten.
  if (sessionRiderId !== riders.activeId()) {
    clearSession(); renderSegment(); refreshButtons(); return;
  }
  if (free) {
    // Ohne Lastsprung anfangen: massgeblich ist die Stufe, die das Rad jetzt
    // wirklich meldet, nicht ein alter Reglerstand aus der Oberflaeche.
    free.reset(live.level || free.level);
    syncFreeLevel(free.level);
    rec.start({ metres: flatMetres, kcal: cumul.kcal, meta: recordingMeta() });
    free.running = true;
    holdScreen();
    refreshButtons();
    return;
  }
  ctl = new HrController({
    hrMax: hrCeiling(),
    // Start from what the rider is actually producing, so the first
    // correction is a nudge rather than a jump.
    startW: live.watts > 20 ? live.watts : 70,
  });
  picker = new LevelPicker();
  rec.start({ metres: flatMetres, kcal: cumul.kcal, meta: recordingMeta() });
  workout.index = 0;
  workout.elapsedInSeg = 0;
  workout.done = false;
  workout.running = true;
  lastSegIndex = -1;
  holdScreen();
  refreshButtons();
};
$('btn-pause').onclick = () => {
  const s = session();
  if (!s) return;
  pausedByDropout = null;           // von Hand angehalten bleibt angehalten
  s.running = !s.running;
  if (s.running) holdScreen(); else releaseScreen();
  refreshButtons();
};
// Am Ende steht oben ein Startknopf, der die Aufzeichnung loeschen wuerde,
// und die Aufzeichnung selbst wartet unter dem Falz. Sie kommt darum von
// selbst ins Bild — nach jeder Trainingsart.
function revealRecording() {
  refreshButtons();
  renderSegment();
  setTimeout(() => {
    if (rec.samples.length)
      $('ride')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 400);
}

$('btn-stop').onclick = () => {
  pausedByDropout = null;
  if (workout) { workout.running = false; workout.index = 0; workout.elapsedInSeg = 0; }
  if (free) free.stop();
  releaseScreen();
  revealRecording();
};
function syncFreeLevel(value) {
  const level = clamp(Math.round(Number(value) || 1), 1, MAX_LEVEL);
  if (free) free.level = level;
  $('free-level').value = level;
  $('free-val').textContent = `Stufe ${level}`;
}
$('free-level').oninput = (e) => syncFreeLevel(e.target.value);
for (const [id, step] of [['free-minus', -1], ['free-plus', 1]]) {
  $(id).onclick = () => {
    syncFreeLevel(Number($('free-level').value) + step);
  };
}

function refreshButtons() {
  const running = !!session()?.running;
  // Die Knopfleiste klebt nur waehrend der Fahrt am unteren Rand. Steht sie
  // immer, verdeckt sie im Ruhezustand "Training ändern" darunter.
  const flag = running ? '1' : '';
  if (document.body.dataset.running !== flag) {
    document.body.dataset.running = flag;
    measureChrome();
  }
  // Start wipes the recording, so it must be unreachable once a session is
  // merely paused - "Weiter" is the button for that.
  const underway = isUnderway();
  const going = running || underway;
  $('btn-start').hidden = going;
  // Nach dem Ziel wischt Start die Aufzeichnung. Der Knopf muss sagen, dass
  // er von vorn beginnt, sonst klickt man ihn statt zu exportieren.
  $('btn-start').textContent = session()?.done ? 'Noch einmal' : 'Start';
  const missingHr = workoutNeedsHr() && (!strap.connected || !hrIsFresh());
  $('btn-start').disabled = !bike.connected || !session() || missingHr;
  // Ein Satz unter dem Startknopf — und zwar der, der gerade im Weg steht.
  // Dass Start eine noch nicht exportierte Aufzeichnung wischt, gehoert
  // davor gesagt und nicht danach.
  const hint = !session() || going ? null
    : !bike.connected ? 'Zum Starten zuerst das Rad verbinden.'
    : missingHr ? 'Für dieses Training zuerst den Pulsgurt verbinden.'
    : rec.samples.length
      ? 'Start beginnt von vorn und verwirft die Aufzeichnung — vorher exportieren.'
    : null;
  $('start-hint').hidden = !hint;
  if (hint) $('start-hint').textContent = hint;
  $('btn-pause').hidden = !going;
  $('btn-pause').textContent = running ? 'Pause' : 'Weiter';
  $('btn-pause').className = running ? 'btn xl' : 'btn primary xl';
  $('btn-stop').hidden = !going;
  $('btn-replan').hidden = !session() || going;
  $('ride').hidden = !rec.samples.length || running;
  refreshProfileLock();
}

// --- keep the screen awake ------------------------------------------------

// A sleeping tablet suspends the page, and the Bluetooth links go with it -
// mid-interval. The lock is dropped by the system whenever the page is
// hidden, so it has to be taken again on every return.
let wakeLock = null;

async function holdScreen() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    toRemote({ ev: 'wakelock-error', message: e.message });
  }
}

function releaseScreen() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session()?.running) holdScreen();
});

// --- the loop ------------------------------------------------------------

let loopBusy = false;
let lastLoopAt = performance.now();
async function appTick() {
  if (loopBusy) return;
  loopBusy = true;
  try {
  const loopAt = performance.now();
  // A delayed browser timer must neither invent one-second ticks nor jump a
  // whole suspended minute into the workout on return.
  const dt = clamp((loopAt - lastLoopAt) / 1000, 0, 2);
  lastLoopAt = loopAt;
  const now = Date.now();
  const hrFresh = hr != null && now - hrAt < 12000;
  const hrNow = hrFresh ? hr : null;
  rpmSmooth = rpmSmooth * 0.6 + live.rpm * 0.4;
  if (bike.connected && live.rpm >= 20) flatMetres += speedForPower(live.watts) * dt;
  // Die Konsole springt von sich aus auf Stufe 1 zurueck, am 2026-09-25 genau
  // alle zehn Minuten, ohne Anlass bei Puls oder Tritt.
  const consoleReset = isConsoleReset(lastLevel, live.level);
  if (live.level) lastLevel = live.level;

  // Reisst die Verbindung, darf die Uhr nicht weiterlaufen. Sonst laeuft im
  // Abschnittstraining ein Intervall ohne Last ab, waehrend man das Rad
  // wieder verbindet.
  // The reason is retained so only an automatic pause is resumed
  // automatically; a pause requested by the rider remains a pause.
  if (session()?.running && !bike.connected) {
    session().running = false;
    pausedByDropout = 'bike';
    refreshButtons();
    setBanner('drop', 'Rad getrennt — angehalten. Es geht von selbst weiter, '
      + 'sobald die Verbindung wieder steht.', 'warn');
  } else if (workout?.running && !workout.current?.watts && !hrFresh) {
    workout.running = false;
    pausedByDropout = 'hr';
    refreshButtons();
    setBanner('drop', 'Pulssignal fehlt — Pulsabschnitt angehalten. Es geht '
      + 'weiter, sobald wieder Messwerte ankommen.', 'warn');
  } else if ((pausedByDropout === 'bike' && bike.connected && session() && !session().done
              && (!workout || workout.current?.watts || hrFresh))
             || (pausedByDropout === 'hr' && hrFresh && workout && !workout.done)) {
    pausedByDropout = null;
    session().running = true;
    setBanner('drop', null);
    holdScreen();
    refreshButtons();
  } else if (pausedByDropout === 'bike' && bike.connected && session() && !session().done) {
    // Das Rad ist zurueck, nur der Puls fehlt noch. „Rad getrennt" waere
    // jetzt falsch und verdeckte den echten Grund des Anhaltens.
    pausedByDropout = 'hr';
    setBanner('drop', 'Pulssignal fehlt — Pulsabschnitt angehalten. Es geht '
      + 'weiter, sobald wieder Messwerte ankommen.', 'warn');
  } else if (!pausedByDropout || !session()) {
    pausedByDropout = null;
    setBanner('drop', null);
  }

  // Remember the interval covered by this tick before advance/step_ can mark
  // the session done. Otherwise every completed ride loses its final second.
  const recordThisTick = !!session()?.running;
  const recordSeg = workout?.current ?? null;
  if (workout) {
    if (workout.advance(dt) && workout.done) {
      $('reason').textContent = 'Training beendet';
      releaseScreen();
      revealRecording();
    }
  }
  if (free) free.advance(dt);
  const seg = workout?.running ? workout.current : null;
  setBanner('hr-safety', seg?.watts && !hrFresh
    ? 'Kein frisches Pulssignal — Wattziel läuft ohne Puls-Obergrenze weiter.'
    : null, 'warn');

  if (free?.running && bike.connected) {
    // Das Rad steht nicht mehr, wo wir es hingestellt haben: von dort aus
    // wieder stufenweise auf die gewaehlte Stufe fahren.
    if (consoleReset) bike.lastLevelSent = live.level;
    const sent = await bike.rampTo(free.level, 1200);
    const ceiling = hrCeiling();
    $('reason').textContent = hrNow && ceiling && hrNow > ceiling
      ? `über deiner Grenze ${ceiling} — Widerstand selbst senken`
      : sent === false
      ? `Freies Training — Stufenbefehl fehlgeschlagen: ${bike.lastError ?? 'unbekannt'}`
      // Die Stufe wird stufenweise angefahren. Bis das Rad nachgezogen hat,
      // waere „Stufe 9" eine Behauptung — es steht noch auf 4.
      : live.level && live.level !== free.level
      ? `Stufe ${free.level} eingestellt — das Rad zieht nach (jetzt ${live.level})`
      : `Freies Training — Stufe ${free.level}`;
  } else if (seg && bike.connected) {
    // A new segment gets a feed-forward jump rather than a fresh search.
    if (workout.index !== lastSegIndex) {
      if (lastSegIndex >= 0 && !seg.watts) ctl.retarget(seg.hrTarget, hrNow);
      lastSegIndex = workout.index;
    }
    const targetW = seg.watts
      ? ctl.holdPower(seg.watts, hrNow)
      : ctl.update({ hrTarget: seg.hrTarget, hrLo: seg.hrLo, hrHi: seg.hrHi,
                     hr: hrNow, rpm: rpmSmooth, now });
    // Inside the zone, hold everything - and keep the power target anchored
    // to what is actually being ridden, so leaving the zone does not start
    // from a stale number and jump.
    const hold = !seg.watts && ctl.satisfied;
    if (hold && live.watts > 20) ctl.targetW = live.watts;
    const cmd = picker.update({ targetW: ctl.targetW, rpm: live.rpm,
                                reportedLevel: live.level, now: now / 1000,
                                levelForPower, hold });
    if (cmd != null && !await bike.setLevel(cmd)) picker.commandFailed();
    $('reason').textContent =
      `${Math.round(targetW)} W angestrebt — ${ctl.reason} — ${picker.note}`;
  } else {
    $('reason').textContent = session()?.done
      ? (free ? 'Freies Training beendet' : 'Training beendet') : 'bereit';
  }

  // Twenty seconds without a changing runtime while the rider is turning is
  // a frozen console. Idle time and a real coast must not trigger this.
  if (bike.connected && stall.since && now - stall.since > 20000) stall.frozen = true;
  if (bike.connected && stall.frozen) {
    if (session()?.running) { session().running = false; pausedByDropout = null; }
    if (!stall.warned) {
      stall.warned = true;
      toRemote({ ev: 'stall', seconds: stall.seconds });
    }
    setDevice('bike', 'err', 'Konsole eingefroren');
    setBanner('stall',
      'Das Rad antwortet, misst aber nicht mehr — Konsole kurz stromlos '
      + 'machen und neu verbinden. Training angehalten.', 'err');
    render(hrNow, seg);
    return;
  }
  setBanner('stall', null);

  if (recordThisTick) {
    rec.add({ hr: hrNow, rpm: live.rpm, watts: live.watts, level: live.level,
              metres: flatMetres, kcal: cumul.kcal,
              hrTarget: recordSeg?.hrTarget ?? null,
              segment: free ? 'Freies Training' : (recordSeg?.label ?? ''), dt });
  }

  render(hrNow, seg);

  toRemote({
    ev: 'state',
    bikeConnected: bike.connected, strapConnected: strap.connected,
    status: bike.status, tx: bike.tx, rx: bike.rx, skipped: bike.skipped,
    interval: bike.interval, err: bike.lastError,
    rpm: live.rpm, watts: live.watts, level: live.level,
    sentLevel: bike.lastLevelSent, pick: picker.note,
    hr: hrNow, seg: seg ? seg.label : null,
    freeLevel: free?.level ?? null,
    hrTarget: seg ? seg.hrTarget : null,
    targetW: Math.round(ctl.targetW), reason: ctl.reason,
  });
  } finally {
    loopBusy = false;
  }
}
setInterval(appTick, 1000);

function render(hrNow, seg) {
  const hero = $('hero');
  $('hr').textContent = hrNow ?? '–';
  hero.dataset.tone = hrNow && seg && !seg.watts
    ? (hrNow > (seg.hrHi ?? seg.hrTarget + 6) ? 'hot'
       : hrNow < (seg.hrLo ?? seg.hrTarget - 6) ? 'cool' : 'good')
    : 'none';

  const zone = hrNow ? zoneAt(hrNow) : null;
  $('zone-tag').hidden = !zone;
  if (zone) {
    $('zone-tag').textContent = zone.name;
    $('zone-tag').style.setProperty('--c', colorOf(zone));
  }

  $('hr-target-label').textContent = seg?.watts ? 'Ziel-Leistung' : 'Zielpuls';
  $('hr-target').textContent = !seg ? '–'
    : seg.watts ? `${seg.watts} W`
    : (seg.hrHi > seg.hrLo ? `${seg.hrLo}–${seg.hrHi}` : seg.hrTarget);
  $('rpm').textContent = live.rpm || '–';
  $('watt').textContent = live.watts ? Math.round(live.watts) : '–';
  $('level').textContent = live.level || '–';
  [...$('level-pips').children].forEach((p, i) => {
    p.classList.toggle('on', i < live.level);
  });
  // Waehrend einer laufenden Einheit ist eine Null bei der Trittfrequenz das
  // Rollenlassen — bergab der Normalfall. Der Hinweis meint die Konsole und
  // gehoert deshalb in die Ruhe davor.
  if (bike.connected && bike.status && !live.rpm && !session()?.running) {
    $('reason').textContent =
      `Rad meldet Zustand "${bike.status}", aber keine Trittfrequenz — `
      + 'Programm am Display starten oder Konsole kurz stromlos machen.';
  }
  // The bike reports distance in 100 m steps, so one decimal is the honest
  // precision - anything finer would be invented.
  $('dist').textContent = flatMetres ? de(flatMetres / 1000, 1) : '–';
  $('kcal').textContent = cumul.kcal ? Math.round(cumul.kcal) : '–';
  $('elapsed').textContent = rec.seconds ? fmtTime(rec.seconds) : '–';

  if (seg && !seg.watts) {
    const lo = seg.hrLo ?? seg.hrTarget - 5, hi = seg.hrHi ?? seg.hrTarget + 5;
    $('zone-band').style.left = hrPos(lo) + '%';
    $('zone-band').style.width = Math.max(1, hrPos(hi) - hrPos(lo)) + '%';
    $('zone-band').hidden = false;
  } else {
    $('zone-band').hidden = true;
  }
  $('zone-now').hidden = !hrNow;
  if (hrNow) $('zone-now').style.left = `${hrPos(hrNow)}%`;

  renderSegment();

  // Nicht ueberschreiben, solange die Konsole als eingefroren gilt — sonst
  // stuende hier eine Sekunde spaeter wieder „verbunden".
  if (bike.connected && !stall.frozen) {
    setDevice('bike', bike.lastError ? 'err' : 'on',
              `verbunden · ${bike.tx}↑ ${bike.rx}↓`
              + (bike.skipped ? ` ${bike.skipped}↺` : '')
              + (bike.lastError ? ` · Fehler: ${bike.lastError}` : ''));
  }

  const s = rec.summary();
  // Die fertige Fahrt gehoert dem, der sie gefahren hat, und geht an dessen
  // Konto — auch wenn inzwischen jemand anders aktiv ist. Dann muss hier
  // stehen, wessen Fahrt da gleich hochgeladen wird.
  const owner = rec.meta?.riderName;
  $('rec-summary').textContent = s
    ? `${fmtTime(s.seconds)} · Ø ${Math.round(s.avgWatts)} W · `
      + `Ø ${Math.round(s.avgRpm)} rpm`
      + (s.avgHr ? ` · Ø ${Math.round(s.avgHr)} bpm, max ${s.maxHr}` : '')
      + (owner && owner !== riders.name() ? ` · gehört ${owner}` : '')
    : 'Noch nichts aufgezeichnet.';
  refreshButtons();
}

let timelineFor = null;

function renderSegment() {
  const live_ = session();
  $('session-empty').hidden = !!live_;
  $('session-live').hidden = !live_;
  const mode = workout ? 'workout' : free ? 'free' : 'none';
  // Messen erzwingt einen Umbruch. Das lohnt beim Wechsel der Ansicht, nicht
  // jede Sekunde — gerechnet wird hier im Sekundentakt.
  if (document.body.dataset.mode !== mode) {
    document.body.dataset.mode = mode;
    measureChrome();
  }
  $('seg-block').hidden = !workout;
  $('free-block').hidden = !free;
  if (free) {
    $('free-state').textContent = free.done ? 'beendet'
      : free.running ? 'läuft' : free.underway ? 'pausiert' : 'bereit';
    $('free-time').textContent = fmtTime(free.seconds);
    return;
  }
  if (!workout) return;

  const tl = $('timeline');
  if (timelineFor !== workout) { drawTimeline(tl, workout.segments); timelineFor = workout; }
  [...tl.children].forEach((b, i) => {
    b.className = workout.done || i < workout.index ? 'past'
      : i === workout.index && isUnderway() ? 'now' : '';
  });
  const before = workout.segments.slice(0, workout.index)
    .reduce((a, s) => a + s.seconds, 0);
  const doneS = workout.done ? workout.total : before + workout.elapsedInSeg;
  $('timeline-cursor').style.left = ((doneS / workout.total) * 100).toFixed(2) + '%';

  const seg = workout.current;
  if (!seg) {
    $('seg-index').textContent = 'Geschafft';
    $('seg-name').textContent = 'Training beendet';
    $('seg-time').textContent = '0:00';
    $('seg-bar').style.width = '100%';
    $('seg-next').textContent = '';
    return;
  }
  const state = workout.running ? `noch ${fmtTime(workout.total - doneS)}`
    : isUnderway() ? 'pausiert' : `${fmtTime(workout.total)} gesamt`;
  $('seg-index').textContent =
    `Abschnitt ${workout.index + 1} / ${workout.segments.length} · ${state}`;
  $('seg-name').textContent = seg.label;
  $('seg-time').textContent = fmtTime(workout.remaining);
  $('seg-bar').style.width =
    ((workout.elapsedInSeg / seg.seconds) * 100).toFixed(1) + '%';
  const next = workout.segments[workout.index + 1];
  $('seg-next').textContent = next
    ? `Danach: ${next.label} — ${fmtTime(next.seconds)} bei ${segTarget(next)}`
    : 'Letzter Abschnitt';
}

// --- export --------------------------------------------------------------

// Der Schluessel gehoert zum Fahrer, nicht zum Geraet — sonst landet die
// Fahrt des zweiten Menschen am Rad im Konto des ersten.
const icuKey = (riderId = riders.activeId()) =>
  riders.getFor(riderId, 'icu')?.key || '';
$('icu-key').value = icuKey();
$('icu-key').oninput = () => {
  riders.set('icu', { ...riders.get('icu'), key: $('icu-key').value.trim() });
};

$('btn-icu').onclick = async () => {
  const msg = $('export-msg');
  if (!rec.samples.length) { msg.textContent = 'Nichts aufgezeichnet.'; return; }
  const ownerId = rec.meta?.riderId ?? riders.activeId();
  const ownerName = rec.meta?.riderName ?? riders.name();
  const key = icuKey(ownerId);
  if (!key) {
    msg.textContent = `Im Profil von ${ownerName} zuerst den intervals.icu-Schlüssel eintragen.`;
    return;
  }
  const btn = $('btn-icu');
  btn.disabled = true;
  msg.textContent = 'sende …';
  try {
    const activity = rec.meta?.activity ?? 'Fahrt';
    const res = await icu.upload({
      key,
      filename: rec.filename('tcx'),
      xml: rec.toTcx(),
      name: `Speed Racer S — ${activity}`,
      // Say plainly where the numbers come from; in a year this is the only
      // record that the power was modelled rather than measured.
      description: 'Hammer Speed Racer S. Leistung aus Widerstandsstufe und '
                 + 'Trittfrequenz berechnet, nicht an der Kurbel gemessen.',
      externalId: 'hammer-' + (rec.startedAt?.toISOString() ?? Date.now()),
    });
    msg.textContent = res?.[0]?.id || res?.id
      ? 'Gesendet — die Fahrt steht in intervals.icu.'
      : 'Gesendet.';
  } catch (e) {
    msg.textContent = 'Fehler: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

$('btn-tcx').onclick = async () => {
  if (!rec.samples.length) { $('export-msg').textContent = 'Nichts aufgezeichnet.'; return; }
  const how = await offerFile(rec.filename('tcx'), rec.toTcx(),
                              'application/vnd.garmin.tcx+xml');
  $('export-msg').textContent = `TCX ${how}.`;
};
$('btn-csv').onclick = async () => {
  if (!rec.samples.length) { $('export-msg').textContent = 'Nichts aufgezeichnet.'; return; }
  const how = await offerFile(rec.filename('csv'), rec.toCsv(), 'text/csv');
  $('export-msg').textContent = `CSV ${how}.`;
};

function bluetoothHint() {
  if (navigator.bluetooth) return null;
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua))
    return 'Safari auf iOS kann kein Web Bluetooth. Diese Seite in Bluefy '
         + 'aus dem App Store öffnen.';
  if (/Linux/.test(ua) && !/Android/.test(ua))
    return 'Chromium auf Linux hat Web Bluetooth hinter einem Flag: '
         + 'chrome://flags/#enable-experimental-web-platform-features '
         + 'aktivieren und Chromium neu starten.';
  if (/Firefox/.test(ua))
    return 'Firefox kann kein Web Bluetooth. Chromium benutzen.';
  return 'Dieser Browser stellt kein Web Bluetooth bereit.';
}

async function diagnose() {
  const lines = [
    `Adresse:      ${location.href}`,
    `sicherer Kontext: ${window.isSecureContext ? 'ja' : 'NEIN'}`,
    `navigator.bluetooth: ${navigator.bluetooth ? 'vorhanden' : 'FEHLT'}`,
  ];
  if (navigator.bluetooth?.getAvailability) {
    try { lines.push(`Adapter verfuegbar: ${await navigator.bluetooth.getAvailability()}`); }
    catch (e) { lines.push(`Adapter-Abfrage: ${e.message}`); }
  }
  lines.push(`getDevices(): ${navigator.bluetooth?.getDevices ? 'vorhanden' : 'fehlt'}`);
  // Wie hoch die Fahransicht wirklich ist, weiss nur das Geraet: Bluefy hat
  // eine feste Leiste, die sich nicht einklappen laesst. Ohne diese Zahlen
  // laesst sich ein Platzproblem auf einem fremden Tablet nur schaetzen.
  // getBoundingClientRect misst relativ zur Scrollposition, darum erst hoch.
  scrollTo(0, 0);
  measureChrome();
  const chrome = getComputedStyle(document.documentElement)
    .getPropertyValue('--chrome').trim();
  lines.push(`Fenster:      ${innerWidth} x ${innerHeight} px`);
  lines.push(`Bildschirm:   ${screen.width} x ${screen.height} px, dpr ${devicePixelRatio}`);
  lines.push(`Kopf+Polster: ${chrome || '?'} — der Rest bleibt dem Cockpit`);
  lines.push(`Ansicht:      ${document.body.dataset.mode || 'keine'}`
           + `${document.body.dataset.running ? ', faehrt' : ''}`);
  lines.push(`Browser:      ${navigator.userAgent}`);
  logLines.push('--- Diagnose ---', ...lines);
  renderLog();
}
$('btn-diag').onclick = diagnose;

// --- start ---------------------------------------------------------------

for (let i = 0; i < MAX_LEVEL; i++)
  $('level-pips').appendChild(document.createElement('i'));

// Wie hoch Kopfleiste, Banner und Polster wirklich sind, weiss nur der
// Browser. Das Layout kommt ohne die Zahl aus — sie steht in der Diagnose,
// damit sich ein Platzproblem auf einem fremden Geraet benennen laesst.
function measureChrome() {
  const app = document.querySelector('.app');
  const cockpit = document.querySelector('.cockpit');
  if (!app || !cockpit) return;
  const cs = getComputedStyle(app);
  const used = cockpit.getBoundingClientRect().top + parseFloat(cs.paddingBottom || 0) + 4;
  document.documentElement.style.setProperty('--chrome', `${Math.round(used)}px`);
}
addEventListener('resize', measureChrome);
addEventListener('orientationchange', () => setTimeout(measureChrome, 250));
measureChrome();

setDevice('bike', 'off', 'nicht verbunden');
setDevice('hr', 'off', 'nicht verbunden');

const HINT = bluetoothHint();
if (HINT) {
  setBanner('bluetooth', HINT, 'err');
  for (const key of ['bike', 'hr']) {
    setDevice(key, 'err', 'kein Web Bluetooth');
    $(`btn-${key}`).disabled = true;
    $(`btn-${key}`).title = HINT;
  }
}

renderRiderChip();
renderRiders();
renderZones();
fillZoneSelects();
drawZoneTrack();
selectProgram(program);
renderSegment();
refreshButtons();

// ?sheet=profile opens a sheet straight away - for bookmarks, and for
// checking the layout in a headless browser.
const SHEETS = { profile: 'sheet-profile', plan: 'sheet-plan',
                 devices: 'sheet-devices', rider: 'sheet-rider' };
const startSheet = SHEETS[new URLSearchParams(location.search).get('sheet')];
if (startSheet) openSheet(startSheet);

// Haken fuer den Trockenlauf im Browser (tools/serve.py). Nur lokal — auf
// GitHub Pages ist LOGGING aus und der Haken wird nicht gesetzt.
if (LOGGING) window.__test = {
  get workout() { return workout; }, get free() { return free; },
  live, cumul, session, render, renderSegment,
  refreshButtons, openSheet, setDevice, setBanner, bike, strap, rec, picker,
  riders, renderRiders, applyRider,
};
