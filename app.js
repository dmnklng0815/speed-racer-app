// Glue: wires the two BLE devices, the controller and the recorder to the UI.

import { Bike, HeartStrap, describeError } from './ble.js?v=b4fba7c';
import { levelForPower, powerFor, MAX_LEVEL } from './fitshow.js?v=b4fba7c';
import { RouteRide, GEARS, RPM_LOW, RPM_HIGH, levelForTorque } from './route.js?v=b4fba7c';
import { HrController, Workout, parseWorkout, LevelPicker }
  from './control.js?v=b4fba7c';
import { Recorder, offerFile } from './record.js?v=b4fba7c';
import * as icu from './icu.js?v=b4fba7c';

const $ = (id) => document.getElementById(id);

const bike = new Bike();
const strap = new HeartStrap();
const rec = new Recorder();
let ctl = new HrController();
let picker = new LevelPicker();
let workout = null;
let route = null;              // RouteRide, wenn eine Strecke geladen ist
let routeOut = null;           // letztes Ergebnis von route.step_()
let routeIndex = [];           // Verzeichnis aus routes/index.json
let routeFinished = false;     // damit das Ziel nur einmal gefeiert wird
let newBest = false;           // war die letzte Fahrt die schnellste?
let pickedRoute = null;        // im Trainingsblatt ausgewaehlter Eintrag

// Abschnittstraining und Strecke schliessen einander aus; geladen ist immer
// hoechstens eins von beidem.
const session = () => workout ?? route;
let manual = false;
let pausedByDropout = null;     // null | 'bike' | 'hr'
// The console can crash while its Bluetooth module keeps answering: valid
// frames, correct checksums, but every value frozen. Without this check the
// app would happily record zeros for a whole session.
const stall = { seconds: null, since: 0, warned: false };

// The console's counters restart from zero when it reboots - which it did
// once today. Carrying an offset keeps distance and calories monotonic, so
// an export never runs backwards.
const carry = { metres: 0, kcal: 0, lastRawM: 0, lastRawK: 0 };

const live = { rpm: 0, watts: 0, level: 0, speedKmh: 0 };
const cumul = { seconds: 0, metres: 0, kcal: 0 };
let hr = null, hrAt = 0;
let rpmSmooth = 0;
let lastSegIndex = -1;

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  const expectsProgress = !!session()?.running && live.rpm >= 20;
  if (expectsProgress && d.seconds === stall.seconds) stall.since ||= Date.now();
  else { stall.seconds = d.seconds; stall.since = 0; stall.warned = false; }

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
// so the app stores what the rider decides rather than inventing it.
const ZONE_KEY = 'hammer.zones.v1';
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
  try {
    const raw = localStorage.getItem(ZONE_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) return value.filter(z => z && typeof z === 'object')
        .map(z => ({ name: String(z.name ?? ''),
                    lo: Number.isFinite(z.lo) ? z.lo : null,
                    hi: Number.isFinite(z.hi) ? z.hi : null }));
    }
  } catch (e) { /* private window, blocked storage - fall through */ }
  return DEFAULT_ZONES.map(z => ({ ...z }));
}
function saveZones() {
  try { localStorage.setItem(ZONE_KEY, JSON.stringify(zones)); }
  catch (e) { $('zone-msg').textContent = 'konnte nicht gespeichert werden'; }
}

let zones = loadZones();
const zoneReady = (z) => z.name && Number.isFinite(z.lo) && Number.isFinite(z.hi)
                         && z.hi >= z.lo;
const colorOf = (z) => ZONE_COLORS[Math.max(0, zones.indexOf(z)) % ZONE_COLORS.length];

function zonesChanged() {
  saveZones(); fillZoneSelects(); checkZones(); drawZoneTrack();
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

/**
 * The safety ceiling is the top of the highest zone. Keeping it as its own
 * input meant two places to state the same number, and the two drift apart.
 */
function hrCeiling() {
  const tops = zones.filter(zoneReady).map(z => z.hi);
  return tops.length ? Math.max(...tops) : null;
}

function renderCeiling() {
  const c = hrCeiling();
  $('ceiling-note').textContent = c
    ? `Obergrenze ${c} bpm — oberer Wert deiner höchsten Zone. `
      + 'Darüber nimmt die App Last weg.'
    : 'Ohne ausgefüllte Zonen gibt es keine Obergrenze.';
}

function checkZones() {
  const ready = zones.filter(zoneReady).length;
  const broken = zones.filter(z => z.lo != null && z.hi != null && z.hi < z.lo);
  $('zone-msg').textContent = broken.length
    ? 'Eine Zone hat „bis" kleiner als „von".'
    : ready
      ? `${ready} von ${zones.length} einsatzbereit`
      : 'Noch keine Zone ausgefüllt';
  $('zone-msg').className = 'msg' + (broken.length ? ' err' : ready ? ' ok' : '');
  // Eine Strecke braucht keine Pulszonen — der Hinweis stand dort als
  // Mahnung fuer etwas, das gar nicht gebraucht wird.
  $('plan-nozones').hidden = ready > 0 || program === 'route';
  renderCeiling();
  return ready > 0 && !broken.length;
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

$('zone-add').onclick = () => {
  zones.push({ name: `Zone ${zones.length + 1}`, lo: null, hi: null });
  renderZones(); zonesChanged();
};

// --- programs ------------------------------------------------------------

// ?prog=interval preselects a tab - handy for a bookmark, and it lets the
// layout be checked in a headless browser without clicking.
const askedProg = new URLSearchParams(location.search).get('prog');
let program = ['interval', 'route'].includes(askedProg) ? askedProg : 'zone';

function selectProgram(p) {
  program = p;
  for (const b of document.querySelectorAll('.tab'))
    b.setAttribute('aria-selected', String(b.dataset.prog === p));
  $('prog-zone').hidden = program !== 'zone';
  $('prog-interval').hidden = program !== 'interval';
  $('prog-route').hidden = program !== 'route';
  // Der Zonenhinweis haengt am Programm, nicht nur an den Zonen: beim
  // Reiterwechsel muss er neu bewertet werden, sonst bleibt er stehen oder
  // weg, je nachdem, womit die Seite geladen wurde.
  checkZones();
  previewPlan();
}
for (const btn of document.querySelectorAll('.tab'))
  btn.onclick = () => selectProgram(btn.dataset.prog);

// --- Strecken ------------------------------------------------------------

// --- Bestzeiten ----------------------------------------------------------

// Je Strecke die schnellste Fahrt, mit ihren Zwischenzeiten auf dem Raster
// des Hoehenprofils. Aus denen wird der Schatten, gegen den beim naechsten
// Mal gefahren wird — rund ein Kilobyte je Strecke.
const BEST_KEY = 'hammer.best.v1';

function loadBest() {
  try {
    const value = JSON.parse(localStorage.getItem(BEST_KEY)) || {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  catch { return {}; }
}

function bestFor(id) { return loadBest()[id] || null; }

/** Speichert, falls schneller als bisher. Gibt zurueck, ob es eine war. */
function saveBest(id, seconds, splits) {
  const all = loadBest();
  const old = all[id];
  if (old && old.seconds <= seconds) return false;
  all[id] = { seconds: Math.round(seconds), at: new Date().toISOString(),
              splits: splits.map(Math.round) };
  try { localStorage.setItem(BEST_KEY, JSON.stringify(all)); }
  catch { return false; }        // voller Speicher darf keine Fahrt kosten
  return true;
}

function clearBest(id) {
  const all = loadBest();
  delete all[id];
  try { localStorage.setItem(BEST_KEY, JSON.stringify(all)); } catch {}
}

const MASS_KEY = 'hammer.mass.v1';
try { $('r-mass').value = Number(localStorage.getItem(MASS_KEY)) || 85; }
catch { $('r-mass').value = 85; }
$('r-mass').onchange = () => {
  const mass = clamp(Number($('r-mass').value) || 85, 40, 160);
  $('r-mass').value = mass;
  try { localStorage.setItem(MASS_KEY, String(mass)); } catch {}
};

const km = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1);

async function loadRouteIndex() {
  try {
    const res = await fetch('routes/index.json', { cache: 'no-cache' });
    const value = res.ok ? await res.json() : [];
    routeIndex = Array.isArray(value) ? value.filter(r => r && typeof r.id === 'string'
      && typeof r.name === 'string' && Number.isFinite(r.distance)) : [];
  } catch {
    routeIndex = [];                 // ohne Strecken bleibt der Reiter leer
  }
  $('route-none').hidden = routeIndex.length > 0;
  const list = $('route-list');
  list.textContent = '';
  for (const r of routeIndex) {
    const b = document.createElement('button');
    b.className = 'route-card';
    b.dataset.id = r.id;
    const best = bestFor(r.id);
    const title = document.createElement('b');
    title.textContent = String(r.name ?? r.id);
    const meta = document.createElement('span');
    meta.className = 'muted small';
    meta.textContent = `${km(r.distance)} km · ${r.ascent} Hm hoch`
      + (r.descent ? ` · ${r.descent} Hm runter` : '')
      + (r.refSeconds ? ` · damals ${fmtTime(r.refSeconds)}` : '');
    b.append(title, meta);
    if (best && Number.isFinite(best.seconds)) {
      const badge = document.createElement('span');
      badge.className = 'best';
      badge.textContent = `Bestzeit ${fmtTime(best.seconds)}`;
      b.appendChild(badge);
    }
    b.onclick = () => { pickedRoute = r; renderRouteChoice(); previewPlan(); };
    list.appendChild(b);
  }
  if (!pickedRoute && routeIndex.length) pickedRoute = routeIndex[0];
  renderRouteChoice();
  if (program === 'route') previewPlan();
}

function renderRouteChoice() {
  for (const b of $('route-list').children)
    b.setAttribute('aria-pressed', String(b.dataset.id === pickedRoute?.id));
  const rawBest = pickedRoute ? bestFor(pickedRoute.id) : null;
  const best = rawBest && Number.isFinite(rawBest.seconds) ? rawBest : null;
  $('route-best').hidden = !best;
  if (best) {
    const d = new Date(best.at);
    $('best-text').textContent = `Deine Bestzeit: ${fmtTime(best.seconds)}`
      + (isNaN(d) ? '' : ` vom ${d.toLocaleDateString('de-DE')}`)
      + ' — dagegen fährst du.';
  }
}
$('best-clear').onclick = () => {
  if (!pickedRoute) return;
  clearBest(pickedRoute.id);
  loadRouteIndex();              // Karte und Hinweis neu zeichnen
};
loadRouteIndex();

const byName = (n) => zones.find(z => z.name === n && zoneReady(z));
const num = (id) => Number($(id).value) || 0;

function seg(minutes, zoneName, label) {
  if (minutes <= 0) return [];          // skipped sections need no zone
  const z = byName(zoneName);
  if (!z) throw new Error(`Für „${label}" ist keine Pulszone ausgefüllt`);
  return [`${minutes}min@${z.lo}-${z.hi} ${label}`];
}

function buildPlan() {
  const lines = [];
  if (program === 'zone') {
    lines.push(...seg(num('z-warm'), $('z-warmzone').value, 'Einfahren'));
    lines.push(...seg(num('z-min'), $('z-zone').value, $('z-zone').value));
    lines.push(...seg(num('z-cool'), $('z-coolzone').value, 'Ausfahren'));
  } else {
    const count = Math.max(1, num('i-count'));
    lines.push(...seg(num('i-warm'), $('i-warmzone').value, 'Einfahren'));
    const part = (kind, label) => {
      const mins = num(`i-${kind}`);
      if (mins <= 0) return [];
      return $(`i-${kind}mode`).value === 'watt'
        ? [`${mins}min@${num(`i-${kind}w`)}W ${label}`]
        : seg(mins, $(`i-${kind}zone`).value, label);
    };
    const work = part('work', 'Belastung');
    const rest = part('rest', 'Erholung');
    if (!work.length) throw new Error('Die Belastung braucht eine Dauer');
    for (let i = 1; i <= count; i++) {
      lines.push(work[0].replace('Belastung', `Belastung ${i}/${count}`));
      if (rest.length && i < count) lines.push(rest[0]);
    }
    lines.push(...seg(num('i-cool'), $('i-coolzone').value, 'Ausfahren'));
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

/** Parse the form as it stands, so the rider sees the ride before loading it. */
function previewPlan() {
  const msg = $('workout-msg');
  if (program === 'route') {
    // Eine Strecke hat keinen Ablauf aus Abschnitten. Der ganze Vorschaublock
    // wiederholte nur, was auf der Streckenkarte schon steht — samt einer
    // zweiten Ueberschrift "Strecke" und derselben Kilometerzahl.
    $('plan-preview').hidden = true;
    $('btn-load').textContent = 'Strecke laden';
    $('plan-timeline').textContent = '';
    if (!pickedRoute) {
      $('route-note').textContent = '';
      $('btn-load').disabled = true;
      return null;
    }
    $('route-note').textContent =
      'Der Widerstand folgt der Steigung. Die Kilometer stehen fest, die Zeit '
      + 'ist dein Ergebnis — die alte Fahrt läuft als Schatten mit.';
    $('btn-load').disabled = false;
    return null;
  }
  $('plan-preview').hidden = false;
  $('btn-load').textContent = 'Training laden';
  try {
    const segs = parseWorkout(buildPlan());
    const secs = segs.reduce((a, s) => a + s.seconds, 0);
    msg.textContent = `${segs.length} Abschnitte · ${Math.round(secs / 60)} min`;
    msg.className = 'msg';
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
$('sheet-plan').addEventListener('input', previewPlan);
$('sheet-plan').addEventListener('change', previewPlan);

$('btn-load').onclick = async () => {
  if (program === 'route') {
    if (!pickedRoute) return;
    const btn = $('btn-load');
    btn.disabled = true;
    try {
      const res = await fetch(`routes/${pickedRoute.id}.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${res.status}`);
      route = new RouteRide(await res.json(), {
        mass: Number($('r-mass').value) || 85,
        auto: $('r-auto').value === '1',
      });
      const best = bestFor(pickedRoute.id);
      if (best && Array.isArray(best.splits)
          && best.splits.length === route.route.altitude.length
          && best.splits.every(Number.isFinite))
        route.setGhost(best.splits, 'Bestzeit');
    } catch (e) {
      $('workout-msg').textContent = `Strecke lässt sich nicht laden (${e.message})`;
      $('workout-msg').className = 'msg err';
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    workout = null;
    routeOut = null;
    closeSheet('sheet-plan');
    drawRoute();
    renderSegment();
    refreshButtons();
    return;
  }
  const segs = previewPlan();
  if (!segs) return;
  workout = new Workout(segs);
  route = null;
  lastSegIndex = -1;
  closeSheet('sheet-plan');
  renderSegment();
  refreshButtons();
};

// --- session controls ----------------------------------------------------

const isUnderway = () => route ? route.underway
  : (!!workout && !workout.done
     && (workout.index > 0 || workout.elapsedInSeg > 0));
const workoutNeedsHr = () => !!workout?.segments.some(s => !s.watts);
const hrIsFresh = () => hr != null && Date.now() - hrAt < 12000;

$('btn-start').onclick = () => {
  if (!session()) return;
  if (route) {
    picker = new LevelPicker();
    rec.start({ metres: 0, kcal: cumul.kcal });
    route.reset();
    routeFinished = false;
    newBest = false;
    route.running = true;
    manual = false;
    $('manual-wrap').hidden = true;
    holdScreen();
    refreshButtons();
    return;
  }
  ctl = new HrController({
    hrMax: hrCeiling() ?? 185,
    // Start from what the rider is actually producing, so the first
    // correction is a nudge rather than a jump.
    startW: live.watts > 20 ? live.watts : 70,
  });
  picker = new LevelPicker();
  rec.start({ metres: cumul.metres, kcal: cumul.kcal });
  workout.index = 0;
  workout.elapsedInSeg = 0;
  workout.done = false;
  workout.running = true;
  lastSegIndex = -1;
  manual = false;
  $('manual-wrap').hidden = true;
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
$('btn-stop').onclick = () => {
  pausedByDropout = null;
  if (workout) { workout.running = false; workout.index = 0; workout.elapsedInSeg = 0; }
  if (route) { route.running = false; route.reset(); routeOut = null; }
  releaseScreen();
  renderSegment();
  refreshButtons();
};
$('btn-manual').onclick = () => {
  manual = !manual;
  if (manual && session()) { session().running = false; releaseScreen(); }
  $('manual-wrap').hidden = !manual;
  refreshButtons();
};
$('manual-level').oninput = (e) => {
  $('manual-val').textContent = 'Stufe ' + e.target.value;
};
for (const [id, step] of [['manual-minus', -1], ['manual-plus', 1]]) {
  $(id).onclick = () => {
    const r = $('manual-level');
    r.value = clamp(Number(r.value) + step, 1, MAX_LEVEL);
    r.dispatchEvent(new Event('input'));
  };
}

function refreshButtons() {
  const running = !!session()?.running;
  // Die Knopfleiste klebt nur waehrend der Fahrt am unteren Rand. Steht sie
  // immer, verdeckt sie im Ruhezustand "Training ändern" und "Handbetrieb"
  // darunter — die liessen sich dann nicht mehr antippen.
  document.body.dataset.running = running ? '1' : '';
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
  $('start-hint').hidden = going || bike.connected || !session();
  if (!going && session() && bike.connected && missingHr) {
    $('start-hint').hidden = false;
    $('start-hint').textContent = 'Für dieses Training zuerst den Pulsgurt verbinden.';
  } else if (!bike.connected) {
    $('start-hint').textContent = 'Zum Starten zuerst das Rad verbinden.';
  }
  $('btn-pause').hidden = !going;
  $('btn-pause').textContent = running ? 'Pause' : 'Weiter';
  $('btn-pause').className = running ? 'btn xl' : 'btn primary xl';
  $('btn-stop').hidden = !going;
  $('btn-replan').hidden = !session() || running;
  // Im Streckenmodus diktiert die Strasse die Stufe. Ein Handbetrieb daneben
  // waere nicht nur sinnlos, er hiesse auch zum zweiten Mal "von Hand" —
  // direkt neben der Schaltung, die etwas ganz anderes meint.
  $('btn-manual').hidden = !!route;
  $('btn-manual').textContent = manual ? 'Automatik' : 'Handbetrieb';
  $('btn-manual').setAttribute('aria-pressed', String(manual));
  $('ride').hidden = !rec.samples.length || running;
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

  // Reisst die Verbindung, darf die Uhr nicht weiterlaufen. Sonst verliert
  // man auf der Strecke Zeit gegen den Schatten, waehrend man das Rad wieder
  // verbindet — und im Abschnittstraining laeuft ein Intervall ohne Last ab.
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
  } else if (!pausedByDropout) {
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
    }
  }
  const seg = workout?.running ? workout.current : null;
  setBanner('hr-safety', seg?.watts && !hrFresh
    ? 'Kein frisches Pulssignal — Wattziel läuft ohne Puls-Obergrenze weiter.'
    : null, 'warn');

  if (route?.running) {
    // Die Leistung kommt vom Rad. Meldet die Konsole keine, wird sie aus
    // Stufe und Trittfrequenz gerechnet — dasselbe Modell, das die Konsole
    // vermutlich selbst benutzt.
    const watts = live.watts > 0 ? live.watts
      : (live.rpm >= 20 ? powerFor(Math.max(1, live.level), live.rpm) : 0);
    routeOut = route.step_(dt, { rpm: live.rpm, watts, level: live.level });
  }

  // Ausserhalb der Bedingung: `step_` setzt beim Zieleinlauf selbst
  // `running = false`. Stuende die Zielbehandlung darin, haenge sie davon ab,
  // dass genau derselbe Takt sie noch sieht — und eine Fahrt, die auf einem
  // anderen Weg ins Ziel kommt, verloere ihre Bestzeit.
  if (route?.done && !routeFinished) {
    routeFinished = true;
    newBest = saveBest(route.route.id, route.seconds, route.splits);
    $('reason').textContent = newBest
      ? `Strecke geschafft — neue Bestzeit ${fmtTime(route.seconds)}`
      : 'Strecke geschafft';
    releaseScreen();
    refreshButtons();
    renderSegment();
    // Ohne das wartet die Aufzeichnung unterhalb des Falzes, waehrend oben
    // ein Startknopf steht, der sie loeschen wuerde.
    setTimeout(() => $('ride')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
  }

  if (manual && bike.connected) {
    const sent = await bike.rampTo(Number($('manual-level').value), 1200);
    $('reason').textContent = sent === false
      ? `Handbetrieb — Stufenbefehl fehlgeschlagen: ${bike.lastError ?? 'unbekannt'}`
      : `Handbetrieb — Stufe ${$('manual-level').value}`;
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
  } else if (route?.running && routeOut && bike.connected) {
    // Der Widerstand folgt der Strasse, nicht einer Uhr. Weil eine Stufe ein
    // festes Drehmoment ist, faellt die Trittfrequenz aus der Rechnung heraus
    // — der Picker bekommt darum das Drehmoment, wo sonst Watt stehen, und
    // eine Umrechnung, die die Kadenz ignoriert.
    const cmd = picker.update({
      targetW: routeOut.torque, rpm: live.rpm, reportedLevel: live.level,
      now: now / 1000, levelForPower: (k) => levelForTorque(k),
    });
    if (cmd != null && !await bike.setLevel(cmd)) picker.commandFailed();
    const ceiling = hrCeiling();
    // Am Berg gibt es keine Entlastung per Knopfdruck — draussen auch nicht.
    // Statt heimlich den Widerstand zu senken, wird es gesagt.
    const zone = hrNow ? zoneAt(hrNow) : null;
    $('reason').textContent = (hrNow && ceiling && hrNow > ceiling)
      ? `über deinem Limit ${ceiling} — leichter treten oder runterschalten`
      : zone ? `im Bereich ${zone.name}` : 'Strecke läuft';
  } else if (!manual) {
    $('reason').textContent = session()?.done
      ? (route ? 'Strecke geschafft' : 'Training beendet') : 'bereit';
  }

  // Twenty seconds without a changing runtime while the rider is turning is
  // a frozen console. Idle time and a real coast must not trigger this.
  if (bike.connected && stall.since && now - stall.since > 20000) {
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
              // Im Streckenmodus zaehlt der virtuelle Weg, nicht der, den das
              // Rad aus seiner eigenen festen Uebersetzung rechnet.
              metres: route ? route.s : cumul.metres, kcal: cumul.kcal,
              hrTarget: recordSeg?.hrTarget ?? null,
              segment: route ? route.route.name : (recordSeg?.label ?? ''), dt });
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
    routeS: route ? Math.round(route.s) : null,
    routeGrade: routeOut ? +(routeOut.grade * 100).toFixed(1) : null,
    gear: route ? route.gearRatio : null,
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
  if (bike.connected && bike.status && !live.rpm) {
    $('reason').textContent =
      `Rad meldet Zustand "${bike.status}", aber keine Trittfrequenz — `
      + 'Programm am Display starten oder Konsole kurz stromlos machen.';
  }
  // The bike reports distance in 100 m steps, so one decimal is the honest
  // precision - anything finer would be invented. Im Streckenmodus zaehlt
  // dagegen der virtuelle Weg, und der ist auf den Meter genau gerechnet.
  $('dist').textContent = route ? km(route.s)
    : cumul.metres ? (cumul.metres / 1000).toFixed(1) : '–';
  if (route) renderRoute();
  $('kcal').textContent = cumul.kcal ? Math.round(cumul.kcal) : '–';
  $('elapsed').textContent = route ? fmtTime(route.seconds)
    : rec.seconds ? fmtTime(rec.seconds) : '–';

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

  if (bike.connected && (!stall.since || Date.now() - stall.since <= 20000)) {
    setDevice('bike', bike.lastError ? 'err' : 'on',
              `verbunden · ${bike.tx}↑ ${bike.rx}↓`
              + (bike.skipped ? ` ${bike.skipped}↺` : '')
              + (bike.lastError ? ` · Fehler: ${bike.lastError}` : ''));
  }

  const s = rec.summary();
  $('rec-summary').textContent = s
    ? `${fmtTime(s.seconds)} · Ø ${Math.round(s.avgWatts)} W · `
      + `Ø ${Math.round(s.avgRpm)} rpm`
      + (s.avgHr ? ` · Ø ${Math.round(s.avgHr)} bpm, max ${s.maxHr}` : '')
    : 'Noch nichts aufgezeichnet.';
  refreshButtons();
}

let timelineFor = null;

// --- Streckenanzeige -----------------------------------------------------

/**
 * Farbe einer Steigung: flach gruen, steil rot, bergab blau.
 *
 * Das Profil traegt die Farbe, damit man sieht, was kommt — und nicht erst
 * merkt, dass es steiler wird, wenn der Widerstand schon da ist.
 */
function gradeColor(grade) {
  const pct = grade * 100;
  if (pct < -1.5) return 'hsl(202 72% 52%)';
  const t = clamp(pct / 14, 0, 1);
  return `hsl(${Math.round(142 - 142 * t)} ${Math.round(48 + 32 * t)}% ${Math.round(48 - 6 * t)}%)`;
}

/** Profil, Farbbaender und Landkarte — einmal je geladener Strecke. */
function drawRoute() {
  if (!route) return;
  const alt = route.route.altitude;
  const n = alt.length;
  const lo = Math.min(...alt), hi = Math.max(...alt);
  const span = (hi - lo) || 1;
  const x = (i) => (i / (n - 1)) * 1000;
  const y = (a) => 200 - ((a - lo) / span) * 180 - 6;

  // Die Farbe fasst rund 100 m zusammen. Punkt fuer Punkt eingefaerbt zeigt
  // das Profil das Rauschen der Hoehenmessung statt der Form des Berges — man
  // sieht ein Streifenmuster und keine Steigung.
  const bands = $('route-bands');
  bands.textContent = '';
  const per = Math.max(1, Math.round(100 / route.step));
  for (let i = 0; i < n - 1; i += per) {
    const to = Math.min(n - 1, i + per);
    let g = 0;
    for (let k = i; k < to; k++) g += route.grade[k];
    g /= (to - i);
    let top = 200;
    for (let k = i; k <= to; k++) top = Math.min(top, y(alt[k]));
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', (x(i) - 0.5).toFixed(2));
    r.setAttribute('width', (x(to) - x(i) + 1).toFixed(2));
    r.setAttribute('y', top.toFixed(2));
    r.setAttribute('height', (200 - top).toFixed(2));
    r.setAttribute('fill', gradeColor(g));
    bands.appendChild(r);
  }
  $('route-line').setAttribute('d',
    alt.map((a, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)} ${y(a).toFixed(2)}`).join(''));
  $('prof-lo').textContent = `${Math.round(lo)} m`;
  $('prof-hi').textContent = `${Math.round(hi)} m`;

  // Landkarte: der Verlauf liegt auf demselben Raster wie das Hoehenprofil,
  // ein Index zeigt also auf beides.
  const track = route.route.track;
  const map = $('route-map');
  const xs = track ? track.map(p => p[0]) : [];
  const ys = track ? track.map(p => p[1]) : [];
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const w = (Math.max(...xs) - x0) || 1, h = (Math.max(...ys) - y0) || 1;
  // Eine Strecke, die ein Tal hinauf und nicht wieder herunter fuehrt, ist auf
  // der Karte ein Strich. Dafuer lohnt die Flaeche nicht — dann bekommt das
  // Hoehenprofil die ganze Breite. Bei einer Runde ist es umgekehrt.
  const worthDrawing = !!track && Math.min(w, h) / Math.max(w, h) > 0.25;
  map.hidden = !worthDrawing;
  $('route-map').closest('.route-view').classList.toggle('no-map', !worthDrawing);
  routeMapPt = null;
  if (worthDrawing) {
    const pad = 6, scale = Math.min((100 - 2 * pad) / w, (100 - 2 * pad) / h);
    // Nord nach oben: die Bildschirmachse zeigt nach unten.
    routeMapPt = (i) => {
      const p = track[Math.max(0, Math.min(track.length - 1, i))];
      return [(50 + (p[0] - x0 - w / 2) * scale).toFixed(2),
              (50 - (p[1] - y0 - h / 2) * scale).toFixed(2)];
    };
    $('map-line').setAttribute('d', track
      .map((_, i) => { const q = routeMapPt(i); return `${i ? 'L' : 'M'}${q[0]} ${q[1]}`; })
      .join(''));
  }
  renderRoute();
}
let routeMapPt = null;

/** Position in Profil und Karte auf 0..1 der Strecke. */
const routeFrac = () => clamp(route.s / route.distance, 0, 1);

function renderRoute() {
  if (!route) return;
  const r = route.route;
  const f = routeFrac();

  $('route-name').textContent = r.name;
  // Oben steht der Zustand, gross steht, was noch kommt. Die Fahrzeit steht
  // links in den Kennzahlen — zweimal braucht sie niemand.
  // Am Ziel ist die Restdistanz null und damit nichts wert. Was dann zaehlt,
  // ist die gefahrene Zeit — sie steht auf demselben Platz.
  // Waehrend der Fahrt traegt die Kopfzeile die Fahrzeit: auf dem Telefon
  // treten die Summen ab, und ohne das waere die Zeit nirgends zu sehen.
  $('route-sub').textContent = route.done ? (newBest ? 'neue Bestzeit' : 'geschafft')
    : isUnderway() && !route.running ? 'pausiert'
    : route.running ? `${fmtTime(route.seconds)} · ${km(r.distance)} km · ${r.ascent} Hm`
    : `${km(r.distance)} km · ${r.ascent} Hm`;
  $('route-left').textContent = route.done ? fmtTime(route.seconds)
    : km(route.remaining);
  $('route-left').nextElementSibling.textContent = route.done
    ? `für ${km(r.distance)} km` : 'km übrig';

  $('route-mark').setAttribute('x1', (f * 1000).toFixed(1));
  $('route-mark').setAttribute('x2', (f * 1000).toFixed(1));
  $('route-veil').setAttribute('x', (f * 1000).toFixed(1));
  $('route-veil').setAttribute('width', ((1 - f) * 1000).toFixed(1));

  if (routeMapPt) {
    const i = Math.round(f * (r.track.length - 1));
    const q = routeMapPt(i);
    $('map-dot').setAttribute('cx', q[0]);
    $('map-dot').setAttribute('cy', q[1]);
    $('map-done').setAttribute('d', r.track.slice(0, i + 1)
      .map((_, k) => { const t = routeMapPt(k); return `${k ? 'L' : 'M'}${t[0]} ${t[1]}`; })
      .join(''));
  }

  // Am Ziel sind Momentwerte eingefroren und luegen: "Tempo 8,3" liest sich,
  // als fuehre man noch. Die vier Kacheln werden darum zum Ergebnis.
  const done = route.done;
  const avg = done && route.seconds
    ? route.distance / 1000 / (route.seconds / 3600) : 0;
  const grade = (done ? r.ascent / r.distance * 100 : route.gradeAt() * 100);
  $('lbl-grade').textContent = done ? 'Ø Steigung' : 'Steigung';
  $('lbl-speed').textContent = done ? 'Ø Tempo' : 'Tempo';
  $('route-grade').textContent = grade.toFixed(1);
  $('route-grade').style.color = done ? '' : gradeColor(route.gradeAt());
  $('route-speed').textContent = (done ? avg : route.speedKmh).toFixed(1);
  $('route-alt').textContent = `${Math.round(done ? r.ascent : route.climbed)}`;

  // Was in 200 m kommt — der Blick nach vorn, den das Profil sonst verlangt.
  const soon = route.gradeAt(Math.min(r.distance, route.s + 200)) * 100;
  $('prof-look').textContent = route.done ? ''
    : `in 200 m ${soon >= 0 ? '+' : ''}${soon.toFixed(1)} %`;

  // "gegen damals +2:12" verlangt, dass man das Vorzeichen deutet — und das
  // Etikett lief auf dem Telefon aus der Kachel. Das Etikett sagt es jetzt
  // selbst, der Wert braucht kein Vorzeichen mehr.
  const ahead = route.ahead;
  const el = $('route-ahead');
  if (ahead == null || !(isUnderway() || route.done)) {
    $('lbl-ahead').textContent = 'gegen';
    el.textContent = '–';
    el.dataset.tone = '';
    $('ahead-ref').textContent = route.ghostLabel;
  } else {
    $('lbl-ahead').textContent = ahead >= 0 ? 'Vorsprung' : 'Rückstand';
    el.textContent = fmtTime(Math.abs(ahead));
    el.dataset.tone = ahead >= 0 ? 'good' : 'bad';
    // Ohne das bliebe offen, gegen wen die Zahl gilt.
    $('ahead-ref').textContent = `auf ${route.ghostLabel}`;
  }

  $('route-why').textContent = route.done ? ''
    : routeOut ? route.explain(routeOut.torque)
    : `${(route.gradeAt() * 100).toFixed(1)} % Steigung am Start`;

  $('cadence-block').hidden = route.done;
  $('gear-block').hidden = route.done;
  if (!route.done) { renderCadence(); renderGear(); }
}

/**
 * Das Kadenzband — hier wird die Schaltung erklaert.
 *
 * Der Zeiger ist die geglaettete Trittfrequenz, das graue Feld das Band, in
 * dem die Automatik nichts tut. Verlaesst der Zeiger das Feld, laeuft ein
 * Balken mit und sagt an, wohin gleich geschaltet wird. Die Wartezeit dafuer
 * bringt die Automatik ohnehin mit — sie wartet, um auf Rauschen nicht
 * anzuspringen. Sichtbar gemacht wird daraus eine Vorwarnung.
 */
const CAD_MIN = 40, CAD_MAX = 130;
const cadPos = (rpm) => clamp((rpm - CAD_MIN) / (CAD_MAX - CAD_MIN), 0, 1) * 100;

function renderCadence() {
  $('cadbar-band').style.left = cadPos(RPM_LOW) + '%';
  $('cadbar-band').style.width = (cadPos(RPM_HIGH) - cadPos(RPM_LOW)) + '%';

  const rpm = route.cadence > 0 ? route.cadence : live.rpm;
  $('cad-now').textContent = live.rpm || '–';
  const now = $('cadbar-now');
  now.hidden = !rpm;
  if (rpm) {
    now.style.left = cadPos(rpm) + '%';
    now.dataset.tone = rpm > RPM_HIGH ? 'high' : rpm < RPM_LOW ? 'low' : 'in';
  }

  const p = route.pending;
  const hint = $('shift-hint');
  const fill = $('cadbar-fill');
  if (p) {
    hint.hidden = false;
    hint.dataset.dir = p.blocked ? 'stuck' : p.dir > 0 ? 'up' : 'down';
    hint.textContent = p.blocked
      ? `${p.why} — ${p.dir > 0 ? 'größter' : 'kleinster'} Gang, mehr geht nicht`
      : `${p.why} — schaltet in ${Math.max(0, Math.ceil(p.in))} s `
        + (p.dir > 0 ? 'hoch' : 'runter');
    fill.hidden = false;
    // Der Balken laeuft von der Bandkante zum Zeiger: er zeigt, wie weit
    // ausserhalb man ist und wie lange das schon so geht.
    const edge = cadPos(p.dir > 0 ? RPM_HIGH : RPM_LOW);
    const at = cadPos(rpm);
    fill.style.left = Math.min(edge, at) + '%';
    fill.style.width = Math.abs(at - edge) + '%';
    fill.dataset.dir = p.blocked ? 'stuck' : p.dir > 0 ? 'up' : 'down';
  } else {
    hint.hidden = true;
    fill.hidden = true;
    // Nach dem Schalten kurz stehen lassen, sonst sieht man es nie.
    const last = route.lastShift;
    if (last && route.seconds - last.at < 4) {
      hint.hidden = false;
      hint.dataset.dir = last.dir > 0 ? 'up' : 'down';
      hint.textContent = `${last.dir > 0 ? 'hoch' : 'runter'}geschaltet auf `
        + `${last.ratio.toFixed(2)} m — ${last.why}`;
    }
  }
}

function renderGear() {
  const ladder = $('gear-ladder');
  if (ladder.children.length !== GEARS.length) {
    ladder.textContent = '';
    for (let i = 0; i < GEARS.length; i++) ladder.appendChild(document.createElement('i'));
  }
  [...ladder.children].forEach((el, i) => {
    el.className = i === route.gear ? 'on' : i < route.gear ? 'below' : '';
  });
  // Gangnummer statt Meter je Kurbelumdrehung: das ist die Groesse, in der
  // ein Rad geschaltet wird. Der Meterwert ist eine Innerei der Rechnung.
  $('gear-val').textContent = `Gang ${route.gear + 1} von ${GEARS.length}`;
  $('gear-auto').setAttribute('aria-pressed', String(route.auto));
  $('gear-auto').textContent = route.auto ? 'automatisch' : 'von Hand';
  // Der Schalter erklaert sich dadurch, dass dasteht, was er tut.
  $('gear-why').textContent = route.auto
    ? `hält dich zwischen ${RPM_LOW} und ${RPM_HIGH} rpm`
    : 'du schaltest selbst — länger heißt langsamer treten';
  $('gear-down').hidden = route.auto;
  $('gear-up').hidden = route.auto;
  $('gear-down').disabled = route.gear === 0;
  $('gear-up').disabled = route.gear === GEARS.length - 1;
}

for (const [id, delta] of [['gear-down', -1], ['gear-up', 1]]) {
  $(id).onclick = () => {
    if (!route) return;
    // Von Hand schalten heisst: die Automatik tritt zurueck. Sonst nimmt sie
    // die Entscheidung Sekunden spaeter wieder zurueck.
    route.auto = false;
    route.shift(delta);
    renderRoute();
  };
}
$('gear-auto').onclick = () => {
  if (!route) return;
  route.auto = !route.auto;
  renderRoute();
};

function renderSegment() {
  const live_ = session();
  $('session-empty').hidden = !!live_;
  $('session-live').hidden = !live_;
  document.body.dataset.mode = route ? 'route' : workout ? 'workout' : 'none';
  measureChrome();
  $('seg-block').hidden = !workout;
  $('route-block').hidden = !route;
  // Kadenz, Strecke und Fahrzeit stehen im Streckenfeld schon — links waeren
  // sie ein zweites Mal dieselbe Zahl.
  $('m-rpm').hidden = !!route;
  $('s-dist').hidden = !!route;
  if (route) { renderRoute(); return; }
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

const icuSettings = icu.loadSettings();
$('icu-key').value = icuSettings.key || '';
$('icu-key').oninput = () => {
  icuSettings.key = $('icu-key').value.trim();
  icu.saveSettings(icuSettings);
};

$('btn-icu').onclick = async () => {
  const msg = $('export-msg');
  if (!rec.samples.length) { msg.textContent = 'Nichts aufgezeichnet.'; return; }
  if (!icuSettings.key) {
    msg.textContent = 'Erst den intervals.icu-Schlüssel im Profil eintragen.';
    return;
  }
  const btn = $('btn-icu');
  btn.disabled = true;
  msg.textContent = 'sende …';
  try {
    const seg = workout?.segments?.[0];
    const res = await icu.upload({
      key: icuSettings.key,
      filename: rec.filename('tcx'),
      xml: rec.toTcx(),
      name: `Speed Racer S — ${seg ? seg.label : 'Fahrt'}`,
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

renderZones();
fillZoneSelects();
drawZoneTrack();
selectProgram(program);
renderSegment();
refreshButtons();

// ?sheet=profile opens a sheet straight away - for bookmarks, and for
// checking the layout in a headless browser.
const SHEETS = { profile: 'sheet-profile', plan: 'sheet-plan', devices: 'sheet-devices' };
const startSheet = SHEETS[new URLSearchParams(location.search).get('sheet')];
if (startSheet) openSheet(startSheet);

// Haken fuer den Trockenlauf im Browser (tools/serve.py). Nur lokal — auf
// GitHub Pages ist LOGGING aus und der Haken wird nicht gesetzt.
if (LOGGING) window.__test = {
  get route() { return route; }, set routeOut(v) { routeOut = v; },
  get workout() { return workout; },
  live, cumul, renderRoute, drawRoute, session, render, renderSegment,
  refreshButtons, openSheet, setDevice, setBanner, bike, strap, rec, picker,
};
