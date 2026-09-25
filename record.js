// Session recording and export.
//
// Everything is kept in memory as one sample per second and can leave the app
// three ways, because a phone browser is an awkward place to save a file:
// download, native share sheet, or plain text to copy.

export class Recorder {
  constructor() {
    this.samples = [];
    this.startedAt = null;
    this.duration = 0;
    this.baseMetres = 0;
    this.baseKcal = 0;
    this.meta = null;
  }

  get seconds() { return this.duration; }

  start({ metres = 0, kcal = 0, startedAt = null, meta = null } = {}) {
    this.samples = [];
    this.startedAt = startedAt == null ? new Date() : new Date(startedAt);
    this.duration = 0;
    this.baseMetres = Number.isFinite(metres) ? metres : 0;
    this.baseKcal = Number.isFinite(kcal) ? kcal : 0;
    this.meta = meta && typeof meta === 'object' ? { ...meta } : null;
  }

  add(s) {
    if (!this.startedAt) this.start();
    this.samples.push({
      t: s.t == null ? new Date() : new Date(s.t),
      hr: s.hr ?? null,
      rpm: s.rpm ?? 0,
      watts: s.watts ?? 0,
      level: s.level ?? 0,
      metres: Math.max(0, (s.metres ?? 0) - this.baseMetres),
      kcal: Math.max(0, (s.kcal ?? 0) - this.baseKcal),
      hrTarget: s.hrTarget ?? null,
      segment: s.segment ?? '',
    });
    this.duration += Number.isFinite(s.dt) ? s.dt : 1;
  }

  summary() {
    const n = this.samples.length;
    if (!n) return null;
    const avg = (k) => this.samples.reduce((a, s) => a + (s[k] || 0), 0) / n;
    const hrs = this.samples.filter(s => s.hr).map(s => s.hr);
    return {
      seconds: this.duration,
      metres: this.samples[n - 1].metres,
      kcal: this.samples[n - 1].kcal,
      avgWatts: avg('watts'),
      avgRpm: avg('rpm'),
      avgHr: hrs.length ? hrs.reduce((a, b) => a + b) / hrs.length : null,
      maxHr: hrs.length ? Math.max(...hrs) : null,
    };
  }

  toCsv() {
    const head = 'zeit,puls,zielpuls,rpm,watt,stufe,meter,kcal,segment';
    const rows = this.samples.map(s => [
      s.t.toISOString(), s.hr ?? '', s.hrTarget ?? '', s.rpm,
      s.watts.toFixed(1), s.level, s.metres, s.kcal.toFixed(1),
      `"${s.segment.replace(/"/g, "'")}"`,
    ].join(','));
    return [head, ...rows].join('\n');
  }

  /** TCX, which Strava and intervals.icu both accept for indoor rides. */
  toTcx() {
    if (!this.samples.length) return '';
    const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
    const sum = this.summary();
    const pts = this.samples.map(s => {
      const bits = [`<Time>${iso(s.t)}</Time>`,
                    `<DistanceMeters>${s.metres}</DistanceMeters>`];
      if (s.hr) bits.push(`<HeartRateBpm><Value>${s.hr}</Value></HeartRateBpm>`);
      bits.push(`<Cadence>${Math.round(s.rpm)}</Cadence>`);
      bits.push('<Extensions><ns3:TPX>'
              + `<ns3:Watts>${Math.round(s.watts)}</ns3:Watts>`
              + '</ns3:TPX></Extensions>');
      return `    <Trackpoint>${bits.join('')}</Trackpoint>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
 <Activities>
  <Activity Sport="Biking">
   <Id>${iso(this.startedAt)}</Id>
   <Lap StartTime="${iso(this.startedAt)}">
    <TotalTimeSeconds>${sum.seconds}</TotalTimeSeconds>
    <DistanceMeters>${sum.metres}</DistanceMeters>
    <Calories>${Math.round(sum.kcal)}</Calories>
    ${sum.maxHr ? `<AverageHeartRateBpm><Value>${Math.round(sum.avgHr)}</Value></AverageHeartRateBpm>
    <MaximumHeartRateBpm><Value>${sum.maxHr}</Value></MaximumHeartRateBpm>` : ''}
    <Intensity>Active</Intensity>
    <TriggerMethod>Manual</TriggerMethod>
    <Track>
${pts.join('\n')}
    </Track>
   </Lap>
   <Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <Name>Hammer Speed Racer S (FitShow FS-BT-D2)</Name>
   </Creator>
  </Activity>
 </Activities>
</TrainingCenterDatabase>`;
  }

  filename(ext) {
    const d = this.startedAt ?? new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `fahrt-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
         + `-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
  }
}

/** Offer a file by whatever route this browser actually supports. */
export async function offerFile(name, text, mime) {
  const file = new File([text], name, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'geteilt'; }
    catch (e) { if (e.name === 'AbortError') return 'abgebrochen'; }
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'heruntergeladen';
  } catch (e) {
    return 'fehlgeschlagen';
  }
}
