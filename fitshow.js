// FitShow FS-BT-D2 protocol, as measured on the Hammer Speed Racer S.
// See docs/PROTOCOL.md for how each field was established.

export const STX = 0x02;
export const ETX = 0x03;
export const MAX_LEVEL = 16;

export const CMD = { CAPS: 0x41, LIVE: 0x42, CUMUL: 0x43, CONTROL: 0x44 };
const SET_LEVEL_SUB = 0x05;

export function frame(cmd, data = []) {
  const body = [cmd, ...data];
  let fcs = 0;
  for (const b of body) fcs ^= b;
  return new Uint8Array([STX, ...body, fcs, ETX]);
}

export function parse(raw) {
  const b = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (b.length < 4 || b[0] !== STX || b[b.length - 1] !== ETX) return null;
  const body = b.slice(1, -2);
  let calc = 0;
  for (const x of body) calc ^= x;
  if (calc !== b[b.length - 2]) return null;
  return { cmd: body[0], data: body.slice(1) };
}

export const askCaps = () => frame(CMD.CAPS, [0x02]);
// The console does not always start measuring on its own. These are the two
// control frames that made it report live data in the very first session.
export const cmdReady = () => frame(CMD.CONTROL, [0x01]);
export const cmdRun = () => frame(CMD.CONTROL, [0x02]);
export const pollLive = () => frame(CMD.LIVE);
export const pollCumul = () => frame(CMD.CUMUL, [0x01]);

export function setLevelFrame(level) {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.round(level)));
  return frame(CMD.CONTROL, [SET_LEVEL_SUB, l]);
}

const u16 = (d, i) => d[i] | (d[i + 1] << 8);

const STATUS = { 0: 'normal', 1: 'end', 2: 'start', 3: 'running', 4: 'stop',
                 5: 'error', 6: 'safety', 7: 'study', 10: 'paused' };

export function decode(cmd, d) {
  if (cmd === CMD.CAPS && d.length >= 5)
    return { type: 'caps', sport: d[0], maxLevel: d[1] };
  if (cmd === CMD.LIVE && d.length >= 11)
    return {
      type: 'live',
      status: STATUS[d[0]] ?? d[0],
      speedKmh: u16(d, 1) / 100,
      level: d[3],
      rpm: d[4],
      hrField: u16(d, 5),          // always 0 so far - see PROTOCOL.md
      watts: u16(d, 7) / 10,
    };
  if (cmd === CMD.CUMUL && d.length >= 9)
    return {
      type: 'cumul',
      seconds: u16(d, 1),
      metres: u16(d, 3),
      kcal: u16(d, 5) / 10,
    };
  if (cmd === CMD.CONTROL) return { type: 'ack', data: d };
  return { type: 'other', cmd, data: d };
}

// Power model, refitted 2026-09-14 over 187 steady-state points spanning
// levels 1-16. A straight line in the level was fitted on levels 1/4/8/16
// and looked excellent there, but overstated level 1 by 33 % - which is
// exactly where a warm-up sits. A power law holds across the whole range:
// worst case 8.6 %, and 4 % at level 1.
export const POWER_K = 0.3651;
export const POWER_E = 0.8900;
export const SPEED_PER_RPM = 0.3746;

export const powerFor = (level, rpm) =>
  POWER_K * Math.pow(level, POWER_E) * rpm;

/** Level that delivers `watts` at the current cadence, or null if coasting. */
export function levelForPower(watts, rpm) {
  if (!rpm || rpm < 20) return null;
  const ratio = watts / (POWER_K * rpm);
  return ratio <= 0 ? 1 : Math.pow(ratio, 1 / POWER_E);
}
