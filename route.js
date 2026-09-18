// Nachfahren einer aufgezeichneten Strecke.
//
// Die Aufzeichnung liefert nur das Hoehenprofil ueber der Distanz. Alles
// andere rechnet die App: aus deiner Leistung wird die virtuelle
// Geschwindigkeit, aus der Steigung an der erreichten Stelle der Widerstand.
// Die Strecke ist distanztreu, nicht zeittreu — die Kilometer stehen fest,
// die Zeit ist dein Ergebnis.
//
// Warum das auf diesem Rad ueberhaupt aufgeht: die Leistung folgt
// `Watt = K x Stufe^E x rpm` (siehe fitshow.js), ist also proportional zur
// Trittfrequenz. Eine Stufe ist damit ein festes *Drehmoment* — und die
// Kraft, die ein Berg verlangt, haengt ebenfalls nicht davon ab, wie schnell
// man kurbelt. Setzt man beides gleich, kuerzt sich die Trittfrequenz weg:
//
//     k_Ziel = F_Strasse x c / (60 x Wirkungsgrad)
//
// Eine Widerstandsstufe entspricht einer Steigung, unabhaengig von der
// Kadenz.

import { POWER_K, POWER_E, MAX_LEVEL } from './fitshow.js?v=b4fba7c';

export const GRAVITY = 9.81;

// Rollwiderstand und Luftwiderstandsflaeche eines Rennrads mit Haenden am
// Oberlenker, Luftdichte auf mittlerer Hoehe. Runde Literaturwerte — sie
// entscheiden ueber das Gefuehl in der Ebene, am Berg dominiert die
// Schwerkraft alles andere.
export const CRR = 0.005;
export const CDA = 0.40;
export const RHO = 1.22;
export const ETA = 0.97;               // Wirkungsgrad des Antriebs

// Statt einer Bremse. Ohne das erreicht eine lange Abfahrt Werte, die
// niemand faehrt — gebremst wird draussen eben auch.
export const MAX_SPEED = 70 / 3.6;     // m/s

// Trittfrequenzband, in dem die Automatik den Fahrer haelt. Draussen schaltet
// man nach Kadenz, nicht nach Widerstand.
//
// Die Spanne ist bewusst weit. Mit 74 bis 96 rpm schaltete der Trockenlauf
// ueber die Bergstrecke fuenfzigmal — ein Gangsprung verschiebt die Kadenz um
// rund 13 rpm, und in einem 22 rpm schmalen Band jagt die Automatik sich
// selbst. 68 bis 100 entspricht ausserdem eher dem, was ein Mensch ohne
// Murren faehrt.
export const RPM_LOW = 68, RPM_HIGH = 100;

// Das Rad hat eine feste Uebersetzung von 6,24 m je Kurbelumdrehung. Damit
// waere schon eine Steigung von 5 % jenseits von Stufe 16 — jede Bergstrecke
// waere unfahrbar. Der virtuelle Gang ist die fehlende Freiheit: draussen
// schaltet man runter, hier muss die App es tun. Die Spanne 1,2 bis 7,5 m je
// Umdrehung deckt 18 % Steigung bis Ebene bei 35 km/h ab, in Schritten von
// 15 % — das entspricht ungefaehr einer echten Kassette.
export const GEARS = [1.20, 1.38, 1.59, 1.83, 2.11, 2.43, 2.80,
                      3.22, 3.71, 4.27, 4.92, 5.66, 6.52, 7.50];

/** Stufe, die dieses Drehmoment liefert — ungerundet, auch ausserhalb 1..16. */
export const levelForTorque = (k) =>
  k <= 0 ? 0 : Math.pow(k / POWER_K, 1 / POWER_E);

/** Drehmoment einer Stufe, in Watt je Umdrehung pro Minute. */
export const torqueOf = (level) => POWER_K * Math.pow(level, POWER_E);

/**
 * Steigungen aus dem Hoehenprofil, an den Rasterpunkten selbst.
 *
 * Zentrale Differenz statt Vorwaertsdifferenz: sie legt den Wert auf den
 * Punkt und nicht zwischen zwei, und laesst sich darum sauber interpolieren.
 */
function gradeSeries(altitude, step) {
  const n = altitude.length;
  const g = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1), hi = Math.min(n - 1, i + 1);
    g[i] = (hi === lo) ? 0 : (altitude[hi] - altitude[lo]) / ((hi - lo) * step);
  }
  return g;                            // Verhaeltnis, nicht Prozent
}

export class RouteRide {
  /**
   * @param route  wie von tools/fit2route.py geschrieben
   * @param opts   mass  Fahrer + Rad in kg
   *               gear  Startgang, sonst automatisch
   *               auto  automatisch schalten (Vorgabe: ja)
   */
  constructor(route, opts = {}) {
    if (!route || !Array.isArray(route.altitude) || route.altitude.length < 2
        || !route.altitude.every(Number.isFinite)
        || !Number.isFinite(route.step) || route.step <= 0
        || !Number.isFinite(route.distance) || route.distance <= 0)
      throw new Error('Streckenprofil ist unvollständig oder ungültig');
    if (route.refTime && (!Array.isArray(route.refTime)
        || route.refTime.length !== route.altitude.length
        || !route.refTime.every(Number.isFinite)))
      throw new Error('Zeitspur der Strecke ist ungültig');
    this.route = route;
    this.step = route.step;
    this.grade = gradeSeries(route.altitude, route.step);
    this.mass = Math.max(40, Math.min(160, opts.mass ?? 85));
    this.auto = opts.auto ?? true;
    this.maxSpeed = opts.maxSpeed ?? MAX_SPEED;

    this.s = 0;                        // virtuelle Position in m
    this.v = 0;                        // virtuelle Geschwindigkeit in m/s
    this.cadence = 0;                  // geglaettet, fuers Schalten
    this.seconds = 0;
    this.coasting = false;             // Fahrer tritt nicht
    this.done = false;
    this.running = false;

    this.gear = opts.gear ?? this.suggestGear();
    this.shiftedAt = -1e9;
    this.railSince = null;
    this.note = 'bereit';

    // Damit der Fahrer die Schaltung kommen sieht, statt von ihr ueberrascht
    // zu werden: solange die Automatik die Wartezeit abzaehlt, steht hier
    // Richtung, Grund und Restzeit. Der Mechanismus bringt dieses Fenster
    // ohnehin mit — er wartet, damit er auf Rauschen nicht anspringt.
    this.pending = null;      // {dir, why, in}
    this.lastShift = null;    // {dir, at, ratio}

    // Zwischenzeiten auf demselben Raster wie das Hoehenprofil: Sekunde, zu
    // der jeder Rasterpunkt erreicht wurde. Daraus wird die Bestzeit, gegen
    // die beim naechsten Mal gefahren wird.
    this.splits = [];
    this.ghost = route.refTime ?? null;   // wogegen gerade gefahren wird
    this.ghostLabel = 'damals';
  }

  // --- Strecke ------------------------------------------------------------

  get distance() { return this.route.distance; }
  get remaining() { return Math.max(0, this.route.distance - this.s); }
  get gearRatio() { return GEARS[this.gear]; }
  get speedKmh() { return this.v * 3.6; }

  /** Linear zwischen den Rasterpunkten einer Profilreihe. */
  _at(series, s) {
    const x = s / this.step;
    const i = Math.floor(x);
    if (i < 0) return series[0];
    if (i >= series.length - 1) return series[series.length - 1];
    return series[i] + (series[i + 1] - series[i]) * (x - i);
  }

  gradeAt(s = this.s) { return this._at(this.grade, s); }
  altitudeAt(s = this.s) { return this._at(this.route.altitude, s); }

  /** Aufgelaufener Hoehengewinn bis zur aktuellen Stelle. */
  get climbed() {
    const a = this.route.altitude;
    const upto = Math.min(a.length - 1, Math.floor(this.s / this.step));
    let up = 0;
    for (let i = 0; i < upto; i++) up += Math.max(0, a[i + 1] - a[i]);
    return up;
  }

  // --- Physik -------------------------------------------------------------

  /**
   * Kraft, die die Strasse bei dieser Geschwindigkeit verlangt.
   *
   * Bergab wird der Schwerkraftanteil negativ und kann Rollen und Luft
   * ueberwiegen — dann ist die Kraft insgesamt negativ, und genau das ist
   * der Fall, in dem draussen der Freilauf klackt.
   */
  roadForce(v, grade) {
    const theta = Math.atan(grade);
    return this.mass * GRAVITY * (Math.sin(theta) + CRR * Math.cos(theta))
         + 0.5 * RHO * CDA * v * v;
  }

  /** Drehmoment, das die Strasse bei diesem Gang am Pedal verlangt. */
  torqueNeeded(v = this.v, grade = this.gradeAt()) {
    return this.roadForce(v, grade) * this.gearRatio / (60 * ETA);
  }

  /**
   * Ein Zeitschritt, gerechnet ueber die Energiebilanz.
   *
   *     d(½ m v²) = (P_Fahrer x Wirkungsgrad − F_Strasse x v) dt
   *
   * Die erste Fassung koppelte die Geschwindigkeit starr an Gang und
   * Trittfrequenz (v = c x rpm). Das war falsch: ein Gangwechsel liess die
   * Geschwindigkeit springen, der Sprung sah wie ein ausgekuppelter Freilauf
   * aus, der Freilauf warf die Stufe auf 1 — und im Trockenlauf schaukelte
   * sich daraus ein Pendeln ueber vierzig Schaltvorgaenge je Runde auf.
   *
   * Ueber die Energie gerechnet hat das virtuelle Rad Masse. Nichts springt,
   * Schwung traegt ueber eine Kuppe, und die Zwangskopplung stellt sich im
   * Gleichgewicht von selbst ein: setzt man dv/dt = 0, folgt v = c x rpm / 60
   * genau dann, wenn die Stufe die der Strasse entsprechende ist. Der Gang
   * bestimmt also nicht die Geschwindigkeit, sondern die Trittfrequenz — wie
   * draussen auch.
   *
   * Rollenlassen, Ebene und Abfahrt brauchen dabei keine Fallunterscheidung:
   * wer nicht tritt, hat P = 0, und die Bilanz macht den Rest.
   *
   * @param dt     Sekunden
   * @param rpm    Trittfrequenz vom Rad
   * @param watts  gemessene Leistung; fehlt sie, wird sie aus Stufe und
   *               Trittfrequenz gerechnet
   * @param level  Stufe, die das Rad gerade meldet
   */
  step_(dt, { rpm = 0, watts = null, level = 1 } = {}) {
    const power = Math.max(0, watts ?? torqueOf(Math.max(1, level)) * rpm);
    this.coasting = rpm < 5;

    // In Teilschritten, damit eine steile Abfahrt bei 1 Hz nicht ueberschwingt.
    const n = 10, h = dt / n;
    for (let i = 0; i < n && !this.done; i++) {
      const grade = this.gradeAt();
      const F = this.roadForce(this.v, grade);
      let energy = 0.5 * this.mass * this.v * this.v
                 + (power * ETA - F * this.v) * h;
      if (energy < 0) energy = 0;
      this.v = Math.min(this.maxSpeed, Math.sqrt(2 * energy / this.mass));
      this.s += this.v * h;
      if (this.s >= this.route.distance) {
        this.s = this.route.distance;
        this.done = true;
        this.running = false;
      }
    }
    this.seconds += dt;
    this.markSplits();

    const grade = this.gradeAt();
    const torque = this.torqueNeeded(this.v, grade);
    if (this.auto) this.autoShift(torque, rpm);

    return {
      grade, torque, power,
      v: this.v,
      // Bergab verlangt die Strasse keine Kraft — Stufe 1 und rollen lassen.
      level: Math.max(1, Math.min(MAX_LEVEL, levelForTorque(torque))),
      descending: torque < torqueOf(1),
      coasting: this.coasting,
    };
  }

  /** Jeden neu erreichten Rasterpunkt mit der Uhrzeit stempeln. */
  markSplits() {
    const upto = Math.min(this.route.altitude.length - 1,
                          Math.floor(this.s / this.step));
    for (let i = this.splits.length; i <= upto; i++) this.splits[i] = this.seconds;
  }

  /**
   * Gegen wen gefahren wird.
   *
   * Sobald eine eigene Zeit vorliegt, ist sie die interessantere Messlatte:
   * die Aufzeichnung stammt von einem anderen Tag, einem anderen Rad und
   * draussen. Gegen die eigene Bestzeit vergleicht man Gleiches.
   */
  setGhost(times, label) {
    this.ghost = times?.length ? times : (this.route.refTime ?? null);
    this.ghostLabel = times?.length ? label : 'damals';
  }

  // --- Getriebe -----------------------------------------------------------

  /**
   * Startgang: die ersten zwei Kilometer sollen in der Mitte des Stufenbands
   * liegen. Was danach kommt, regelt die Automatik ohnehin.
   */
  suggestGear() {
    const ahead = this.grade.slice(0, Math.max(2, Math.round(2000 / this.step)));
    const sorted = [...ahead].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const steepest = sorted[sorted.length - 1];

    const forceAt = (g, v) => {
      const theta = Math.atan(g);
      return this.mass * GRAVITY * (Math.sin(theta) + CRR * Math.cos(theta))
           + 0.5 * RHO * CDA * v * v;
    };
    // 6 m/s als Platzhalter fuers Tempo — der Luftanteil ist am Anfang klein.
    const want = forceAt(median, 6) > 0
      ? torqueOf(8) * 60 * ETA / forceAt(median, 6)
      : GEARS[GEARS.length - 1];
    // ... aber die steilste Rampe darf das Rad nicht ueberfordern.
    const ceiling = forceAt(steepest, 4) > 0
      ? torqueOf(15) * 60 * ETA / forceAt(steepest, 4)
      : GEARS[GEARS.length - 1];
    const limit = Math.min(want, ceiling);

    for (let i = GEARS.length - 1; i >= 0; i--)
      if (GEARS[i] <= limit) return i;
    return 0;
  }

  shift(delta) {
    const next = Math.max(0, Math.min(GEARS.length - 1, this.gear + delta));
    if (next === this.gear) return false;
    this.gear = next;
    this.shiftedAt = this.seconds;
    this.railSince = null;
    this.pending = null;
    return true;
  }

  /**
   * Automatisch schalten.
   *
   * Gefahren wird nach Trittfrequenz, wie draussen: wer ausdreht, schaltet
   * hoch, wer wuergt, schaltet runter. Die Stufengrenzen des Rads gehen vor —
   * ueber 16 kann es nicht schwerer und unter 1 nicht leichter, und dann muss
   * der Gang es richten, sonst passt der Widerstand nicht mehr zur Steigung.
   *
   * Eine erste Fassung entschied allein nach der Stufe. Im Trockenlauf klebte
   * der Fahrer damit die ganze Ebene entlang bei 115 rpm: die Stufe lag bei 3
   * und damit genau auf der Bandgrenze, also schaltete nie etwas — waehrend
   * der Gang offensichtlich viel zu kurz war.
   */
  autoShift(torque, rpm) {
    const HOLD = 6, LOCK = 12, SETTLE = 15;
    // Aus dem Stand stimmt noch nichts: das Tempo ist null, die Kadenz hoch,
    // und die Automatik schaltet zweimal hin und zurueck, bevor die Fahrt
    // ueberhaupt laeuft.
    if (this.seconds < SETTLE || rpm < 25) { this.railSince = null; return; }
    const a = 1 - Math.exp(-1 / 6);              // 6 s Glaettung
    this.cadence += (rpm - this.cadence) * a;

    const want = levelForTorque(torque);
    let dir = 0, why = '';
    if (want > 15.5) { dir = -1; why = 'Stufe am oberen Anschlag'; }
    else if (want < 1.15) { dir = +1; why = 'Stufe am unteren Anschlag'; }
    else if (this.cadence > RPM_HIGH) { dir = +1; why = 'du drehst aus'; }
    else if (this.cadence < RPM_LOW) { dir = -1; why = 'du würgst'; }

    if (!dir) { this.railSince = null; this.pending = null; return; }
    if (this.railSince == null) this.railSince = this.seconds;

    // Ab wann darf geschaltet werden — beides muss erfuellt sein.
    const readyAt = Math.max(this.railSince + HOLD, this.shiftedAt + LOCK);
    if (this.gear + dir < 0 || this.gear + dir >= GEARS.length) {
      // Der Zeiger steht sichtbar ausserhalb des Bands und es passiert
      // nichts — ohne diesen Hinweis sieht das aus wie ein Fehler.
      this.pending = { dir, why, in: null, blocked: true };
      this.note = dir > 0 ? 'groesster Gang' : 'kleinster Gang';
      return;
    }
    if (this.seconds < readyAt) {
      this.pending = { dir, why, in: readyAt - this.seconds };
      return;
    }
    this.pending = null;
    if (this.shift(dir)) {
      this.note = dir > 0 ? 'hochgeschaltet' : 'runtergeschaltet';
      this.lastShift = { dir, at: this.seconds, ratio: this.gearRatio, why };
      // Sonst steht die geglaettete Kadenz sofort wieder ausserhalb des
      // Bands und die Automatik schaltet gleich noch einmal.
      this.cadence = dir > 0 ? RPM_HIGH - 14 : RPM_LOW + 14;
    }
  }

  /**
   * Die Kette Steigung -> Kraft -> Gang -> Stufe in einem Satz.
   *
   * Der Widerstand aendert sich hier nicht, weil eine Uhr ablaeuft, sondern
   * weil der Berg steiler wird. Das soll man lesen koennen.
   */
  explain(torque) {
    const pct = (this.gradeAt() * 100).toFixed(1);
    const force = Math.round(this.roadForce(this.v, this.gradeAt()));
    const lvl = Math.max(1, Math.min(MAX_LEVEL, levelForTorque(torque)));
    // Gangnummer, nicht Meter je Umdrehung: der Satz muss dieselbe Sprache
    // sprechen wie die Anzeige darunter.
    return `${pct} % Steigung · ${force} N am Rad · Gang ${this.gear + 1}`
         + ` → Stufe ${lvl.toFixed(1)}`;
  }

  /** Alles zurueck auf den Start, fuer einen neuen Versuch. */
  reset() {
    this.splits = [];
    this.s = 0; this.v = 0; this.seconds = 0; this.cadence = 0;
    this.done = false; this.coasting = false;
    this.gear = this.suggestGear();
    this.shiftedAt = -1e9; this.railSince = null;
    this.pending = null; this.lastShift = null;
    this.note = 'bereit';
  }

  /** Laeuft die Fahrt schon, wenn auch gerade pausiert? */
  get underway() { return this.seconds > 0 && !this.done; }

  // --- Schatten der Originalfahrt ----------------------------------------

  /** Sekunden, die der Schatten bis zu dieser Stelle gebraucht hat. */
  refAt(s = this.s) {
    const ref = this.ghost;
    return ref?.length ? this._at(ref, s) : null;
  }

  /** Vorsprung in Sekunden: positiv = schneller als damals. */
  get ahead() {
    const r = this.refAt();
    return r == null ? null : r - this.seconds;
  }
}
