// Heart-rate controller and workout runner.
//
// Heart rate is a slow, lagging signal: pushing power at it with a fast loop
// just makes it oscillate. Two things keep this stable.
//
// 1. The inner loop is not a loop at all. Because the bike's power model is
//    known exactly, the level that delivers a target power at the current
//    cadence is a direct calculation (see fitshow.js). No feedback, no
//    hunting - and the rider cannot dodge the target by spinning slower.
//
// 2. The outer loop corrects on *predicted* error: where the heart rate is
//    heading in `lead` seconds, not where it is now. Without that it always
//    overshoots, because the effect of a power change only shows up a minute
//    later.

export class HrController {
  constructor(opts = {}) {
    this.kp = opts.kp ?? 1.5;             // watts per bpm of predicted error
    this.lead = opts.lead ?? 60;          // seconds to look ahead
    this.deadband = opts.deadband ?? 2;   // bpm - stops needless fidgeting
    this.stepClamp = opts.stepClamp ?? 8; // max watt change per update
    this.minW = opts.minW ?? 25;
    this.maxW = opts.maxW ?? 400;
    this.hrMax = opts.hrMax ?? 180;       // hard ceiling
    this.hrRest = opts.hrRest ?? 60;      // anchor for the feed-forward
    // Swept in tools/sweep_lookahead.mjs: without the forecast the loop
    // still lands on target on average but swings 28.6 bpm at segment
    // changes; capped around 10-15 the worst swing falls to 8.9.
    this.slopeClamp = opts.slopeClamp ?? 12; // bpm the forecast may contribute
    this.warmupS = opts.warmupS ?? 60;    // ignore the slope before this
    this.targetW = opts.startW ?? 70;
    this.history = [];                    // {t, bpm}, trimmed to 40 s
    this.firstAt = null;                  // start of the ride, for warm-up
    this.lastUpdate = 0;
    this.satisfied = false;   // true while the heart rate needs no correction
    this.reason = 'bereit';
  }

  /**
   * Jump the power target when the heart-rate target changes, instead of
   * feeling for it. Heart rate above rest rises roughly in proportion to
   * power, so the load that held `hr` scales to the load that should hold
   * `hrTarget`. The feedback loop then only has to trim, which is the
   * difference between reaching a 3-minute interval's target and missing it.
   */
  retarget(hrTarget, hr) {
    if (!hr || hr <= this.hrRest + 5) return;
    const scaled = this.targetW * (hrTarget - this.hrRest) / (hr - this.hrRest);
    this.targetW = Math.max(this.minW, Math.min(this.maxW, scaled));
    this.reason = `Vorsteuerung auf ${Math.round(this.targetW)} W`;
  }

  /**
   * Hold a power target outright.
   *
   * For intervals this is the right control variable: heart rate needs a
   * minute or two to answer a change in load, so a short interval steered by
   * heart rate is too easy at the start and too hard at the end. Power
   * applies instantly and is not moved by sleep, heat or caffeine. Heart
   * rate stays on as a ceiling.
   */
  holdPower(watts, hr) {
    if (hr != null && hr > this.hrMax) {
      this.cut = (this.cut ?? 0) + 5;
      this.reason = `Puls über Limit ${this.hrMax} — gedrosselt`;
    } else {
      this.cut = Math.max(0, (this.cut ?? 0) - 2);
      this.reason = `${Math.round(watts - this.cut)} W gehalten`;
    }
    this.targetW = Math.max(this.minW, Math.min(this.maxW, watts - this.cut));
    return this.targetW;
  }

  pushHr(bpm, t = Date.now()) {
    if (this.firstAt == null) this.firstAt = t;
    this.history.push({ t, bpm });
    const cutoff = t - 40000;
    while (this.history.length && this.history[0].t < cutoff)
      this.history.shift();
  }

  /** Least-squares slope of heart rate, in bpm per minute. */
  slopePerMin(now = Date.now()) {
    const h = this.history.filter(p => p.t > now - 25000);
    if (h.length < 6) return 0;
    const t0 = h[0].t;
    const xs = h.map(p => (p.t - t0) / 1000);
    const ys = h.map(p => p.bpm);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b) / n;
    const my = ys.reduce((a, b) => a + b) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    return den ? (num / den) * 60 : 0;
  }

  /**
   * Advance the outer loop. Returns the target power in watts.
   * `hr` null means the strap has dropped out.
   */
  update({ hrTarget, hrLo, hrHi, hr, rpm, now = Date.now() }) {
    if (now - this.lastUpdate < 5000) return this.targetW;
    this.lastUpdate = now;

    if (hr == null) {
      // No heart rate: ease off rather than hold an unknown load.
      this.targetW = Math.max(this.minW, this.targetW - 10);
      this.satisfied = false;
      this.reason = 'kein Puls - faellt zurueck';
      return this.targetW;
    }
    if (hr > this.hrMax) {
      this.targetW = Math.max(this.minW, this.targetW - 25);
      this.satisfied = false;
      this.reason = `Puls ueber Limit ${this.hrMax}`;
      return this.targetW;
    }
    if (!rpm || rpm < 20) {
      this.satisfied = true;
      this.reason = 'Pause - haelt';
      return this.targetW;                 // no wind-up while coasting
    }

    // At the start of a ride heart rate climbs steeply simply because the
    // rider came off the sofa, not because the load is too high. Reading
    // that as "about to overshoot" throttles the warm-up to nothing, so the
    // forecast is ignored until there is real history, and is capped even
    // then - it is a damper, never the dominant term.
    const riding = this.firstAt == null ? 0 : (now - this.firstAt) / 1000;
    const slope = riding >= this.warmupS ? this.slopePerMin(now) : 0;
    const lookahead = Math.max(-this.slopeClamp,
                      Math.min(this.slopeClamp, slope * (this.lead / 60)));
    const predicted = hr + lookahead;
    const err = hrTarget - predicted;

    // A zone is a band, not a point: inside it there is nothing to correct,
    // so the load is left alone and the ride stays quiet.
    const band = (hrLo != null && hrHi != null) ? (hrHi - hrLo) / 2 : 0;
    const slack = Math.max(this.deadband, band);
    if (Math.abs(err) < slack) {
      this.satisfied = true;
      this.reason = band
        ? `in Zone ${hrLo}-${hrHi} (${Math.round(predicted)} erwartet)`
        : `im Ziel (${Math.round(predicted)} erwartet)`;
      return this.targetW;
    }

    this.satisfied = false;
    const delta = Math.max(-this.stepClamp,
                  Math.min(this.stepClamp, this.kp * err));
    this.targetW = Math.max(this.minW, Math.min(this.maxW,
                   this.targetW + delta));
    this.reason = `${err > 0 ? '+' : ''}${delta.toFixed(0)} W `
                + `(erwartet ${Math.round(predicted)}, Ziel ${hrTarget})`;
    return this.targetW;
  }
}

const DUR = /^(\d+(?:\.\d+)?)(s|sec|min|m)?$/i;

function parseDuration(text) {
  if (text.includes(':')) {
    const [m, s] = text.split(':').map(Number);
    return m * 60 + (s || 0);
  }
  const m = DUR.exec(text);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = (m[2] || 'min').toLowerCase();
  return unit.startsWith('s') ? v : v * 60;
}

/**
 * Workout text, one segment per line:
 *
 *   10min@110 Einfahren
 *   6x 4min@150 Intervall + 2min@120 Pause
 *   5min@105 Ausfahren
 */
export function parseWorkout(text) {
  const segments = [];
  for (let raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let repeat = 1;
    let rest = line;
    const rep = /^(\d+)\s*x\s+(.*)$/i.exec(line);
    if (rep) { repeat = parseInt(rep[1], 10); rest = rep[2]; }
    const parts = rest.split('+').map(s => s.trim()).filter(Boolean);
    const block = [];
    for (const part of parts) {
      const w = /^(\S+)\s*@\s*(\d+)\s*[wW]\b\s*(.*)$/.exec(part);
      if (w) {
        const seconds = parseDuration(w[1]);
        if (!seconds) throw new Error(`Dauer unklar: "${w[1]}"`);
        block.push({ seconds, watts: parseInt(w[2], 10),
                     label: w[3] || `${w[2]} W` });
        continue;
      }
      const m = /^(\S+)\s*@\s*(\d+)(?:\s*-\s*(\d+))?\s*(.*)$/.exec(part);
      if (!m) throw new Error(`Zeile nicht verstanden: "${line}"`);
      const seconds = parseDuration(m[1]);
      if (!seconds) throw new Error(`Dauer unklar: "${m[1]}"`);
      const lo = parseInt(m[2], 10);
      const hi = m[3] ? parseInt(m[3], 10) : lo;
      if (hi < lo) throw new Error(`Zone verdreht: "${part}"`);
      block.push({
        seconds, hrLo: lo, hrHi: hi,
        hrTarget: Math.round((lo + hi) / 2),
        label: m[4] || (hi > lo ? `${lo}-${hi} bpm` : `${lo} bpm`),
      });
    }
    for (let i = 0; i < repeat; i++) segments.push(...block.map(s => ({ ...s })));
  }
  if (!segments.length) throw new Error('Kein Segment gefunden');
  return segments;
}

export class Workout {
  constructor(segments) {
    this.segments = segments;
    this.index = 0;
    this.elapsedInSeg = 0;
    this.running = false;
    this.done = false;
  }

  get total() { return this.segments.reduce((a, s) => a + s.seconds, 0); }
  get current() { return this.segments[this.index] ?? null; }

  advance(dt) {
    if (!this.running || this.done) return false;
    this.elapsedInSeg += dt;
    let changed = false;
    while (this.current && this.elapsedInSeg >= this.current.seconds) {
      this.elapsedInSeg -= this.current.seconds;
      this.index++;
      changed = true;
      if (this.index >= this.segments.length) {
        this.done = true;
        this.running = false;
        return true;
      }
    }
    return changed;
  }

  get remaining() {
    return this.current ? Math.max(0, this.current.seconds - this.elapsedInSeg) : 0;
  }
}


/**
 * Chooses which resistance level to command.
 *
 * Three things make this feel settled rather than twitchy on the bike:
 *
 * 1. Cadence is smoothed over several seconds. The exact level follows
 *    `targetW / rpm`, so raw cadence wobble would make the brake breathe.
 * 2. A level only changes once the demand has stood clear of the current
 *    level for a few seconds. Without that, a demand hovering at 5.5 flips
 *    between 5 and 6 forever.
 * 3. The rider wins. If the display reports a level we did not command,
 *    someone turned it by hand - we adopt that as the new baseline instead
 *    of fighting them back.
 */
export class LevelPicker {
  constructor(opts = {}) {
    // Defaults from the sweep in tools/sweep_picker.mjs: hysteresis 1.0
    // costs 0.4 bpm of tracking and saves a third of all level changes.
    // Tightening further buys little calm and clearly hurts tracking.
    this.tau = opts.tau ?? 12;           // seconds of cadence smoothing
    this.hysteresis = opts.hysteresis ?? 1.0;
    this.persist = opts.persist ?? 3;    // seconds the demand must hold
    this.urgent = opts.urgent ?? 1.5;    // a gap this big is not noise
    this.minGap = opts.minGap ?? 2;      // seconds between commands
    this.rpm = 0;
    this.current = null;                 // what we believe is set
    this.since = 0;
    this.lastCmdAt = -1e9;
    this.beforeCommand = null;           // state to restore if the write fails
    this.beforeSince = null;
    this.note = '';
  }

  /** Returns the level to command, or null to leave things alone. */
  update({ targetW, rpm, reportedLevel, now, levelForPower, hold = false }) {
    const a = 1 - Math.exp(-1 / this.tau);
    this.rpm += (rpm - this.rpm) * a;

    // The rider's own adjustment always wins over our bookkeeping.
    if (reportedLevel && reportedLevel !== this.current
        && now - this.lastCmdAt > 3) {
      this.current = reportedLevel;
      this.since = now;
    }
    if (this.current == null && reportedLevel) this.current = reportedLevel;

    if (this.rpm < 20) { this.note = 'zu langsam zum Rechnen'; return null; }

    // While the heart rate sits inside its band there is nothing to correct.
    // Chasing a stale power target here would move the brake for no reason a
    // rider can feel a purpose in - the load should change when the body
    // says so, not when arithmetic says so.
    if (hold) {
      this.since = now;
      this.note = `in Zone — Stufe ${this.current ?? '?'} bleibt`;
      return null;
    }

    const raw = levelForPower(targetW, this.rpm);
    if (raw == null) { this.note = 'kein Wert'; return null; }
    const want = Math.max(1, Math.min(16, raw));
    const cur = this.current ?? Math.round(want);
    const gap = want - cur;

    if (Math.abs(gap) < this.hysteresis) {
      this.since = now;
      this.note = `Stufe ${cur} passt (${want.toFixed(1)})`;
      return null;
    }
    // The settling wait exists to ignore noise. A gap this wide is not
    // noise - it is the rider having changed something - so act at once.
    if (Math.abs(gap) < this.urgent && now - this.since < this.persist) {
      this.note = `wartet ab (${want.toFixed(1)} gegen ${cur})`;
      return null;
    }
    if (now - this.lastCmdAt < this.minGap) return null;

    // Bigger gaps move two steps at a time so warm-ups do not crawl.
    const step = Math.abs(gap) >= 3 ? 2 : 1;
    const next = Math.max(1, Math.min(16, cur + Math.sign(gap) * step));
    this.beforeCommand = cur;
    this.beforeSince = this.since;
    this.current = next;
    this.lastCmdAt = now;
    this.since = now;
    this.note = `Stufe ${next} (Bedarf ${want.toFixed(1)})`;
    return next;
  }

  /** Let a failed BLE write be retried on the next controller pass. */
  commandFailed() {
    this.current = this.beforeCommand ?? this.current;
    // The settling clock has to go back as well. Left at the moment of the
    // failed write it keeps the "wartet ab" gate shut for `persist` seconds -
    // delaying exactly the retry this method exists to allow.
    this.since = this.beforeSince ?? this.since;
    this.lastCmdAt = -1e9;
    this.note = 'Stufenbefehl fehlgeschlagen — neuer Versuch';
  }
}
