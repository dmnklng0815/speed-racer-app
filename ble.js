// Web Bluetooth wrappers for the two devices this app talks to.

import { askCaps, cmdReady, cmdRun, pollLive, pollCumul, setLevelFrame,
         parse, decode } from './fitshow.js?v=5bff2d4';

/** Not every Web Bluetooth implementation rejects with a real Error.
 *  Bluefy on iOS can throw a bare value, which turns a diagnosis into
 *  "undefined undefined" unless it is handled here. */
export function describeError(e) {
  if (e === undefined || e === null) return 'leere Ablehnung ohne Fehlerobjekt';
  if (typeof e === 'string') return e;
  if (typeof e === 'number') {
    // Bluefy rejects with a bare CoreBluetooth-style code and no text.
    const known = {
      1: 'ungültige Angaben', 2: 'ungültige Angabe oder nicht unterstützt',
      3: 'nicht verbunden', 5: 'abgebrochen', 6: 'Zeitüberschreitung',
      7: 'Gerät hat die Verbindung getrennt',
    };
    return `Fehlercode ${e}${known[e] ? ` (${known[e]})` : ''}`;
  }
  const name = e.name ?? e.code ?? '';
  const msg = e.message ?? e.description ?? '';
  if (name || msg) return `${name}${name && msg ? ': ' : ''}${msg}`;
  try { return JSON.stringify(e).slice(0, 200); } catch (_) { return String(e); }
}

/**
 * Hat die Implementierung den *Filter* nicht verstanden?
 *
 * Bluefy baut Web Bluetooth auf CoreBluetooth nach und lehnt eine Filterform,
 * die Chromium kennt, mit einem nackten Wert ohne Fehlerobjekt ab. Das ist
 * der einzige Fall, in dem es sich lohnt, dieselbe Frage ohne Filter noch
 * einmal zu stellen.
 */
export function filterRejected(err) {
  if (err === undefined || err === null) return true;
  if (typeof err === 'number' || typeof err === 'string') return true;
  return err.name === 'TypeError' || err.name === 'NotSupportedError';
}

/**
 * Ask for a device, and fall back to showing everything if the filtered
 * request fails *because the filter was not understood*.
 *
 * Nicht bei jedem Fehlschlag, und das ist der Punkt: `requestDevice`
 * verbraucht die Nutzergeste. Der zweite Aufruf hat keine mehr, Chromium
 * beantwortet ihn immer mit `SecurityError: Must be handling a user gesture`
 * — und diese Meldung ersetzte dann den wahren Grund, meistens schlicht
 * „Auswahl abgebrochen". Ein geschlossener Auswahldialog ist eine Antwort,
 * kein kaputter Filter; und fuer „nichts in der Liste" gibt es den Schalter
 * *Alle Geräte zeigen*, einen bewussten Tipp entfernt.
 */
async function pick(filtered, all, onLog) {
  try {
    return await navigator.bluetooth.requestDevice(filtered);
  } catch (err) {
    if (!filterRejected(err)) throw err;
    onLog(`gefilterte Suche fehlgeschlagen (${describeError(err)}) — `
          + 'zeige alle Geräte');
    try {
      return await navigator.bluetooth.requestDevice(all);
    } catch (zweiter) {
      // Ohne Nutzergeste sagt der zweite Fehler nichts ueber das Geraet.
      // Der erste bleibt der wahre, und der Schalter ist der Ausweg.
      if (zweiter?.name === 'SecurityError')
        throw new Error(`${describeError(err)} — noch einmal tippen, `
          + 'diesmal mit „Alle Geräte zeigen"');
      throw zweiter;
    }
  }
}

// Written out in full rather than as 16-bit numbers. Chromium accepts the
// short form, but Bluefy on iOS reimplements Web Bluetooth over CoreBluetooth
// and rejected it with a bare numeric code - the canonical form is what every
// implementation understands.
const SVC_FITSHOW = '0000fff0-0000-1000-8000-00805f9b34fb';
const CH_NOTIFY = '0000fff1-0000-1000-8000-00805f9b34fb';
const CH_WRITE = '0000fff2-0000-1000-8000-00805f9b34fb';
const SVC_HR = '0000180d-0000-1000-8000-00805f9b34fb';
const CH_HR = '00002a37-0000-1000-8000-00805f9b34fb';

/** The bike: polled at 2 Hz, and commanded when the controller asks. */
export class Bike {
  constructor() {
    this.device = null;
    this.write = null;
    this.timer = null;
    this.tick = 0;
    this.onLive = () => {};
    this.onCumul = () => {};
    this.onLog = () => {};
    this.onState = () => {};
    this.lastLevelSent = null;
    this.lastLevelAt = 0;
    this.tx = 0;
    this.rx = 0;
    this.sending = false;
    this.writeChain = Promise.resolve();
    this.queuedWrites = 0;
    this.unanswered = 0;
    this.lastRxAt = Date.now();
    this.skipped = 0;
    this.interval = 500;
    this.lastError = null;
  }

  get connected() { return !!this.device?.gatt?.connected; }

  async connect({ any = false } = {}) {
    // The bike only advertises while awake, so a miss here usually means
    // "nobody is pedalling" rather than a bad filter.
    const all = { acceptAllDevices: true, optionalServices: [SVC_FITSHOW] };
    const picked = any ? await navigator.bluetooth.requestDevice(all)
      : await pick({ filters: [{ services: [SVC_FITSHOW] }],
                     optionalServices: [SVC_FITSHOW] }, all, this.onLog);
    if (this.device && this.device !== picked) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
      if (this.device.gatt?.connected) this.device.gatt.disconnect();
    }
    this.device = picked;
    this.giveUp = false;
    this._onDisconnect ??= () => {
      this.stopPolling();
      this.onState('disconnected');
      if (!this.giveUp && !this.reconnectTask)
        this.reconnectTask = this.reconnect().finally(() => { this.reconnectTask = null; });
    };
    this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    await this.attach();
  }

  /**
   * Re-open a link the radio dropped. The device object survives the
   * disconnect, so this needs no picker and no user gesture - a dropout
   * mid-session must not cost the ride.
   */
  async reconnect(tries = 8) {
    for (let i = 1; i <= tries && !this.giveUp; i++) {
      await new Promise(r => setTimeout(r, Math.min(1000 * i, 5000)));
      if (this.device?.gatt?.connected) return true;
      try {
        await this.attach();
        this.onLog(`wiederverbunden nach Versuch ${i}`);
        return true;
      } catch (err) {
        this.onLog(`Wiederverbinden ${i}/${tries}: ${err.message}`);
      }
    }
    this.onState('lost');
    return false;
  }

  async attach() {
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SVC_FITSHOW);
    const notify = await svc.getCharacteristic(CH_NOTIFY);
    this.write = await svc.getCharacteristic(CH_WRITE);

    if (this.notify && this._onNotify)
      this.notify.removeEventListener('characteristicvaluechanged', this._onNotify);
    this.notify = notify;
    this._onNotify = (e) => {
      const v = e.target.value;
      const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      this.rx++;
      this.unanswered = Math.max(0, this.unanswered - 1);
      this.lastRxAt = Date.now();
      const p = parse(raw);
      if (!p) { this.onLog('rx UNGUELTIG', raw); return; }
      const dec = decode(p.cmd, p.data);
      this.onLog('rx', raw, dec);
      if (dec.type === 'live') { this.status = dec.status; this.onLive(dec); }
      else if (dec.type === 'cumul') this.onCumul(dec);
    };
    notify.addEventListener('characteristicvaluechanged', this._onNotify);
    await notify.startNotifications();
    this.unanswered = 0;
    this.lastRxAt = Date.now();
    this.lastError = null;
    if (!await this.send(askCaps())) throw new Error('Capabilities konnten nicht abgefragt werden');
    this.lastLevelSent = null;          // the bike may have been reset
    this.onState('connected');
  }

  /**
   * Ask the console to start measuring. It does not always do so by itself -
   * after a reboot it can sit in a summary screen, answering the protocol
   * while reporting nothing. Only sent on a fresh connect, never on a
   * reconnect, because it appears to restart the session counters.
   */
  async start() {
    if (!await this.send(cmdReady())) throw new Error('READY konnte nicht gesendet werden');
    await new Promise(r => setTimeout(r, 400));
    if (!await this.send(cmdRun())) throw new Error('RUN konnte nicht gesendet werden');
    this.onLog('Startbefehle an die Konsole gesendet');
  }

  async send(bytes, { polling = false } = {}) {
    if (!this.write || !this.connected) return false;
    // Polls may be dropped; control commands must never be. A single promise
    // chain serialises CoreBluetooth writes without silently losing a level.
    if (polling && this.queuedWrites) { this.skipped++; return false; }
    this.queuedWrites++;
    const op = this.writeChain.catch(() => {}).then(async () => {
      if (!this.write || !this.connected) return false;
      this.sending = true;
      try {
        if (this.write.writeValueWithoutResponse)
          await this.write.writeValueWithoutResponse(bytes);
        else await this.write.writeValue(bytes);
        this.tx++;
        this.unanswered++;
        this.lastError = null;
        this.onLog('tx', bytes);
        return true;
      } catch (err) {
        this.lastError = describeError(err);
        this.onLog('tx FEHLGESCHLAGEN: ' + this.lastError, bytes);
        return false;
      } finally {
        this.sending = false;
      }
    });
    this.writeChain = op.then(() => undefined, () => undefined);
    try { return await op; }
    finally { this.queuedWrites--; }
  }

  startPolling() {
    this.stopPolling();
    const step = () => {
      // If answers are falling behind, stop asking for a moment. Polling a
      // device that is already struggling is what pushes it over.
      if (this.unanswered > 3 && Date.now() - this.lastRxAt < 3000) {
        this.skipped++;
        if (this.skipped % 8 === 0 && this.interval < 1500) {
          this.interval += 250;
          this.onLog(`Abfrage verlangsamt auf ${this.interval} ms`);
          this.stopPolling();
          this.timer = setInterval(step, this.interval);
        }
        return;
      }
      if (this.unanswered > 3) {
        this.onLog('Antwort-Timeout — Abfrage wird neu synchronisiert');
        this.unanswered = 0;
        this.lastRxAt = Date.now();
      }
      this.tick++;
      this.send(this.tick % 2 ? pollLive() : pollCumul(), { polling: true });
    };
    this.timer = setInterval(step, this.interval);
  }

  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Command a level, but never faster than one step every `minGapMs` and
   * never more than one step at a time - a jump under load hurts the knees.
   */
  async rampTo(level, minGapMs = 2000) {
    const now = Date.now();
    const want = Math.max(1, Math.min(16, Math.round(level)));
    if (this.lastLevelSent === want) return;
    if (now - this.lastLevelAt < minGapMs) return;
    let next = want;
    if (this.lastLevelSent != null)
      next = this.lastLevelSent + Math.sign(want - this.lastLevelSent);
    if (await this.send(setLevelFrame(next))) {
      this.lastLevelSent = next;
      this.lastLevelAt = now;
      return true;
    }
    return false;
  }

  /** Command a level outright; pacing is the LevelPicker's job. */
  async setLevel(level) {
    const l = Math.max(1, Math.min(16, Math.round(level)));
    if (await this.send(setLevelFrame(l))) {
      this.lastLevelSent = l;
      this.lastLevelAt = Date.now();
      return true;
    }
    return false;
  }

  async disconnect() {
    this.giveUp = true;                 // a deliberate stop must not retry
    this.stopPolling();
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
}

/** Standard Heart Rate Service - works with the Garmin HRM 200 and any
 *  other strap that speaks 0x180D. */
export class HeartStrap {
  constructor() {
    this.device = null;
    this.onHr = () => {};
    this.onState = () => {};
    // `pick()` protokolliert einen fehlgeschlagenen Filter. Ohne Vorgabe
    // stuerzte das Verbinden genau dort ab, wo es erklaeren wollte, warum.
    this.onLog = () => {};
    this.lastAt = 0;
  }

  get connected() { return !!this.device?.gatt?.connected; }
  get staleFor() { return this.lastAt ? (Date.now() - this.lastAt) / 1000 : Infinity; }

  async connect({ any = false } = {}) {
    // A filter matches what the device puts in its advertisement, not what
    // it offers once connected. The HRM 200 does not advertise 0x180D while
    // in pairing mode, so the name is the reliable hook here.
    const all = { acceptAllDevices: true, optionalServices: [SVC_HR] };
    const picked = any ? await navigator.bluetooth.requestDevice(all)
      : await pick({ filters: [{ services: [SVC_HR] }],
                     optionalServices: [SVC_HR] }, all, this.onLog);
    if (this.device && this.device !== picked) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
      if (this.device.gatt?.connected) this.device.gatt.disconnect();
    }
    this.device = picked;
    this.giveUp = false;
    this._onDisconnect ??= () => {
      this.onState('disconnected');
      if (!this.giveUp && !this.reconnectTask)
        this.reconnectTask = this.reconnect().finally(() => { this.reconnectTask = null; });
    };
    this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    await this.attach();
  }

  async reconnect(tries = 8) {
    for (let i = 1; i <= tries && !this.giveUp; i++) {
      await new Promise(r => setTimeout(r, Math.min(1000 * i, 5000)));
      if (this.device?.gatt?.connected) return true;
      try { await this.attach(); return true; }
      catch (err) { this.onLog(`Gurt-Wiederverbinden ${i}/${tries}: ${describeError(err)}`); }
    }
    this.onState('lost');
    return false;
  }

  async attach() {
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SVC_HR);
    const ch = await svc.getCharacteristic(CH_HR);
    if (this.notify && this._onNotify)
      this.notify.removeEventListener('characteristicvaluechanged', this._onNotify);
    this.notify = ch;
    this._onNotify = (e) => {
      const r = this.parseHr(e.target.value);
      this.lastAt = Date.now();
      this.onHr(r);
    };
    ch.addEventListener('characteristicvaluechanged', this._onNotify);
    await ch.startNotifications();
    this.onState('connected');
  }

  /** 0x2A37: flags byte, then 8- or 16-bit BPM, optional energy, optional RR. */
  parseHr(view) {
    const flags = view.getUint8(0);
    let i = 1;
    const bpm = (flags & 0x01) ? view.getUint16(i, true) : view.getUint8(i);
    i += (flags & 0x01) ? 2 : 1;
    if (flags & 0x08) i += 2;                      // energy expended
    const rr = [];
    if (flags & 0x10) {
      for (; i + 1 < view.byteLength; i += 2)
        rr.push(view.getUint16(i, true) / 1024);   // seconds
    }
    return { bpm, rr, contact: !!(flags & 0x02) };
  }

  async disconnect() {
    this.giveUp = true;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
}
