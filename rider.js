// Wer faehrt.
//
// Diese Groessen im Browserspeicher gehoeren der Person und nicht dem Geraet:
// Pulszonen, die getrennte Belastungsgrenze, Referenzleistung, Systemgewicht,
// Bestzeiten und intervals.icu-Schluessel. Lagen sie global, faehrt der
// zweite Mensch am selben Rad nach fremden Zonen, bergauf mit fremdem Gewicht,
// gegen einen fremden Schatten — und seine Fahrt landet in einem fremden Konto.
//
// Darum ein Profil je Fahrer, eines davon aktiv. Ein eigener Schluessel je
// Profil und nicht alles in einem: eine Bestzeit zu speichern schreibt dann
// nicht den ganzen Haushalt neu, und ein kaputtes Profil nimmt die anderen
// nicht mit. Das Profil ist bewusst ein in sich geschlossenes Objekt — genau
// die Einheit, die spaeter per Link auf ein zweites Geraet wandern soll.

const LIST_KEY = 'hammer.riders.v1';
const keyFor = (id) => `hammer.rider.${id}.v1`;

// Die globalen Schluessel der Fassung vor den Profilen.
const LEGACY = { zones: 'hammer.zones.v1', icu: 'hammer.icu.v1' };
export const FIRST_NAME = 'Ich';
export const MAX_NAME = 24;

const FIELDS = ['zones', 'hrLimit', 'refPower', 'icu'];

function memoryStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

// Ein privates Fenster kann beim blossen Zugriff werfen, nicht erst beim
// Schreiben. Wer nicht speichern kann, soll trotzdem fahren koennen: dann
// haelt der Speicher eben nur diese Sitzung.
function defaultStore() {
  try {
    const probe = '__hammer_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryStore();
  }
}

const cleanName = (name) => String(name ?? '').trim().slice(0, MAX_NAME);

function emptyProfile(name) {
  return { name: cleanName(name) || FIRST_NAME, zones: null,
           hrLimit: null, refPower: null, icu: {} };
}

export class Riders {
  constructor(store) {
    this.store = store ?? defaultStore();
    this.index = this.readIndex_() ?? this.firstRun_();
    this.profile = this.readProfile_(this.index.active);
  }

  // --- Speicher ----------------------------------------------------------

  read_(k) {
    try { return JSON.parse(this.store.getItem(k)); }
    catch { return null; }
  }

  /** Schreibt und sagt, ob es angekommen ist. Voller Speicher darf keine
   *  Fahrt kosten, also wird der Fehler zurueckgegeben statt geworfen. */
  write_(k, value) {
    try { this.store.setItem(k, JSON.stringify(value)); return true; }
    catch { return false; }
  }

  drop_(k) { try { this.store.removeItem(k); } catch { /* egal */ } }

  readIndex_() {
    const raw = this.read_(LIST_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const list = Array.isArray(raw.list)
      ? raw.list.filter(r => r && typeof r.id === 'string' && r.id
                          && typeof r.name === 'string')
                .map(r => ({ id: r.id, name: cleanName(r.name) || FIRST_NAME }))
      : [];
    if (!list.length) return null;
    const active = list.some(r => r.id === raw.active) ? raw.active : list[0].id;
    return { active, list };
  }

  readProfile_(id) {
    const raw = this.read_(keyFor(id));
    const known = this.index.list.find(r => r.id === id);
    const p = emptyProfile(known?.name);
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.zones)) p.zones = raw.zones;
      if (Number.isFinite(raw.hrLimit)) p.hrLimit = raw.hrLimit;
      if (Number.isFinite(raw.refPower)) p.refPower = raw.refPower;
      if (raw.icu && typeof raw.icu === 'object' && !Array.isArray(raw.icu))
        p.icu = raw.icu;
    }
    return p;
  }

  saveIndex_() { return this.write_(LIST_KEY, this.index); }
  saveProfile_() { return this.write_(keyFor(this.index.active), this.profile); }

  /** Kurz, lesbar im Schluesselnamen, und kollisionsfrei genug fuer den Tag,
   *  an dem zwei Geraete ihre Profile zusammenlegen. */
  newId_() {
    for (let i = 0; i < 50; i++) {
      const id = 'r' + Math.random().toString(36).slice(2, 8);
      if (!this.index?.list.some(r => r.id === id)) return id;
    }
    return 'r' + Date.now().toString(36);
  }

  // --- Umzug aus der Fassung ohne Profile ---------------------------------

  // Still und ohne Rueckfrage: wer die App bisher allein benutzt hat, soll
  // nichts verlieren und nichts bemerken.
  firstRun_() {
    const p = emptyProfile(FIRST_NAME);
    const zones = this.read_(LEGACY.zones);
    if (Array.isArray(zones)) p.zones = zones;
    const icu = this.read_(LEGACY.icu);
    if (icu && typeof icu === 'object' && !Array.isArray(icu)) p.icu = icu;

    const id = this.newId_();
    const index = { active: id, list: [{ id, name: p.name }] };
    const ok = this.write_(keyFor(id), p) && this.write_(LIST_KEY, index);

    // Erst loeschen, wenn das Neue nachweislich lesbar ist — sonst nimmt ein
    // voller Speicher die Zonen mit, statt nur den Umzug zu verweigern.
    if (ok && this.read_(keyFor(id)) && this.read_(LIST_KEY))
      for (const k of Object.values(LEGACY)) this.drop_(k);

    return index;
  }

  // --- Fahrer -------------------------------------------------------------

  list() { return this.index.list.map(r => ({ ...r })); }
  activeId() { return this.index.active; }
  name() { return this.index.list.find(r => r.id === this.index.active).name; }

  use(id) {
    if (id === this.index.active) return this.profile;
    if (!this.index.list.some(r => r.id === id)) return this.profile;
    this.index.active = id;
    this.saveIndex_();
    this.profile = this.readProfile_(id);
    return this.profile;
  }

  /** Legt einen Fahrer an und macht ihn aktiv — angelegt wird er, um zu
   *  fahren. Gibt die Kennung zurueck. */
  add(name) {
    const id = this.newId_();
    this.index.list.push({ id, name: cleanName(name) || `Fahrer ${this.index.list.length + 1}` });
    this.index.active = id;
    this.saveIndex_();
    this.profile = emptyProfile(this.index.list.at(-1).name);
    this.saveProfile_();
    return id;
  }

  rename(id, name) {
    const entry = this.index.list.find(r => r.id === id);
    if (!entry) return;
    entry.name = cleanName(name) || entry.name;
    this.saveIndex_();
    if (id === this.index.active) {
      this.profile.name = entry.name;
      this.saveProfile_();
    }
  }

  /** Der letzte Fahrer bleibt: ohne Profil gibt es keine Zonen und kein
   *  Gewicht, und ein leerer Kopf waere schwerer zu erklaeren als ein
   *  ungenutztes Profil. */
  remove(id) {
    if (this.index.list.length < 2) return false;
    const i = this.index.list.findIndex(r => r.id === id);
    if (i < 0) return false;
    this.index.list.splice(i, 1);
    this.drop_(keyFor(id));
    if (this.index.active === id) {
      this.index.active = this.index.list[0].id;
      this.profile = this.readProfile_(this.index.active);
    }
    this.saveIndex_();
    return true;
  }

  // --- Inhalt des aktiven Profils -----------------------------------------

  get(field) {
    if (!FIELDS.includes(field)) throw new Error(`Unbekanntes Feld: ${field}`);
    return this.profile[field];
  }

  /** Feld eines bestimmten Fahrers, auch wenn inzwischen jemand anders aktiv
   *  ist. Eine fertige Aufzeichnung bleibt so beim Fahrer, der sie fuhr. */
  getFor(id, field) {
    if (!FIELDS.includes(field)) throw new Error(`Unbekanntes Feld: ${field}`);
    if (!this.index.list.some(r => r.id === id)) return null;
    return id === this.index.active ? this.profile[field]
      : this.readProfile_(id)[field];
  }

  set(field, value) {
    if (!FIELDS.includes(field)) throw new Error(`Unbekanntes Feld: ${field}`);
    this.profile[field] = value;
    return this.saveProfile_();
  }
}
