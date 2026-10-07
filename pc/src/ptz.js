/**
 * PTZ control for Hikvision cameras over ISAPI.
 *
 * A camera with `ptz` set in the registry (its ISAPI channel number, usually
 * 1) can be driven from the player page. Commands go to the camera's HTTP
 * port with the same login its RTSP URL carries, so nothing extra is stored.
 *
 * ISAPI only speaks HTTP Digest auth, which fetch() does not do on its own,
 * so the handshake lives here: one 401 to collect the challenge, then every
 * later call sends the Authorization header up front.
 */
import crypto from 'node:crypto';
import { hostOf } from './discover.js';

const TIMEOUT_MS = 4000;

/** Speed range ISAPI accepts for continuous moves. */
export const SPEED_MAX = 100;

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** Credentials from the RTSP URL. Greedy to the last '@', like withHost(). */
function credsOf(rtspUrl) {
  const m = /^rtsp:\/\/(.*)@[^/:?@]+/i.exec(String(rtspUrl));
  if (!m) return null;
  const i = m[1].indexOf(':');
  const user = i < 0 ? m[1] : m[1].slice(0, i);
  const pass = i < 0 ? '' : m[1].slice(i + 1);
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  return { user: dec(user), pass: dec(pass) };
}

/** host -> parsed WWW-Authenticate challenge, reused until the camera rejects it. */
const challenges = new Map();
let nc = 0;

function parseChallenge(header) {
  const out = {};
  for (const m of String(header).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]*))/g)) {
    out[m[1]] = m[2] ?? m[3];
  }
  return out;
}

function digestHeader(chal, { user, pass }, method, uri) {
  const ha1 = md5(`${user}:${chal.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const ncStr = String(++nc).padStart(8, '0');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const qop = chal.qop ? 'auth' : null;
  const response = qop
    ? md5(`${ha1}:${chal.nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${chal.nonce}:${ha2}`);

  const parts = [
    `username="${user}"`,
    `realm="${chal.realm}"`,
    `nonce="${chal.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    'algorithm="MD5"',
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncStr}`, `cnonce="${cnonce}"`);
  if (chal.opaque) parts.push(`opaque="${chal.opaque}"`);
  return 'Digest ' + parts.join(', ');
}

async function isapi(cam, method, uri, body) {
  const host = hostOf(cam.rtspUrl);
  const creds = credsOf(cam.rtspUrl);
  if (!host || !creds) throw new Error(`"${cam.name}": cannot read host/login from its RTSP URL`);

  const send = (auth) =>
    fetch(`http://${host}${uri}`, {
      method,
      body,
      headers: {
        ...(body ? { 'Content-Type': 'application/xml' } : {}),
        ...(auth ? { Authorization: auth } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  let chal = challenges.get(host);
  let res = await send(chal ? digestHeader(chal, creds, method, uri) : null);

  if (res.status === 401) {
    const header = res.headers.get('www-authenticate') || '';
    if (!/^digest/i.test(header)) throw new Error(`"${cam.name}": camera wants ${header.split(' ')[0] || 'unknown'} auth, not Digest`);
    chal = parseChallenge(header);
    challenges.set(host, chal);
    res = await send(digestHeader(chal, creds, method, uri));
  }

  const text = await res.text();
  if (res.status === 401) throw new Error(`"${cam.name}": camera rejected the login`);
  if (!res.ok) {
    const why = /<statusString>([^<]*)/.exec(text)?.[1] || /<subStatusCode>([^<]*)/.exec(text)?.[1] || res.statusText;
    throw new Error(`"${cam.name}": camera said ${res.status} ${why}`);
  }
  return text;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

/**
 * Start moving. Each axis is -100..100; 0 stops that axis. All zeros stops
 * everything. The camera keeps going until told to stop.
 */
export function move(cam, { pan = 0, tilt = 0, zoom = 0 } = {}) {
  const p = Math.round(clamp(pan, -SPEED_MAX, SPEED_MAX));
  const t = Math.round(clamp(tilt, -SPEED_MAX, SPEED_MAX));
  const z = Math.round(clamp(zoom, -SPEED_MAX, SPEED_MAX));
  return isapi(cam, 'PUT', `/ISAPI/PTZCtrl/channels/${cam.ptz}/continuous`,
    `<PTZData><pan>${p}</pan><tilt>${t}</tilt><zoom>${z}</zoom></PTZData>`);
}

export function stop(cam) {
  return move(cam, {});
}

export async function presets(cam) {
  const xml = await isapi(cam, 'GET', `/ISAPI/PTZCtrl/channels/${cam.ptz}/presets`);
  const out = [];
  for (const m of xml.matchAll(/<PTZPreset>([\s\S]*?)<\/PTZPreset>/g)) {
    const id = Number(/<id>(\d+)/.exec(m[1])?.[1]);
    const name = /<presetName>([^<]*)/.exec(m[1])?.[1] ?? '';
    if (id) out.push({ id, name: name || `Preset ${id}` });
  }
  return out;
}

export function gotoPreset(cam, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1 || n > 300) throw new Error('preset must be 1-300');
  return isapi(cam, 'PUT', `/ISAPI/PTZCtrl/channels/${cam.ptz}/presets/${n}/goto`);
}

/** Store the camera's current position as preset `id` (1-32 are the user slots). */
export function savePreset(cam, id, name) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error('preset must be 1-32');
  const label = String(name || `Preset ${n}`).slice(0, 32).replace(/[<>&]/g, '');
  return isapi(cam, 'PUT', `/ISAPI/PTZCtrl/channels/${cam.ptz}/presets/${n}`,
    `<PTZPreset><id>${n}</id><presetName>${label}</presetName></PTZPreset>`);
}

/** Where the camera points: degrees, and zoom as a multiplier. */
export async function status(cam) {
  const xml = await isapi(cam, 'GET', `/ISAPI/PTZCtrl/channels/${cam.ptz}/status`);
  const num = (tag) => Number(new RegExp(`<${tag}>(-?\\d+)`).exec(xml)?.[1]);
  // ISAPI reports tenths: azimuth 3230 = 323.0 deg, absoluteZoom 10 = 1.0x.
  return { azimuth: num('azimuth') / 10, elevation: num('elevation') / 10, zoom: num('absoluteZoom') / 10 };
}

/**
 * Centre on a point (or zoom into a box) of the camera's own image. x/y/w/h are
 * fractions 0..1 of the frame, origin top-left: {x:0.5,y:0.5} is "stay put",
 * {x:0.25,y:0.5} pans left a quarter of the view. ISAPI calls this 3D
 * positioning and wants the box in a 0..255 grid.
 */
export function look(cam, { x, y, w = 0, h = 0 }) {
  const f = (v) => Math.max(0, Math.min(1, Number(v)));
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error('x and y (0..1) are required');
  const cx = f(x), cy = f(y), bw = f(w), bh = f(h);
  const g = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const [x1, y1, x2, y2] = [g(cx - bw / 2), g(cy - bh / 2), g(cx + bw / 2), g(cy + bh / 2)];
  return isapi(cam, 'PUT', `/ISAPI/PTZCtrl/channels/${cam.ptz}/position3D`,
    `<Position3D><StartPoint><positionX>${x1}</positionX><positionY>${y1}</positionY></StartPoint>` +
    `<EndPoint><positionX>${x2}</positionX><positionY>${y2}</positionY></EndPoint></Position3D>`);
}

/**
 * Park action: after `seconds` with no PTZ command the camera goes back to
 * `preset` by itself. The camera enforces this, so it survives our restarts.
 */
export async function getPark(cam) {
  const xml = await isapi(cam, 'GET', `/ISAPI/PTZCtrl/channels/${cam.ptz}/parkaction`);
  const type = /<ActionType>([^<]*)/.exec(xml)?.[1];
  return {
    enabled: /<enabled>true/.test(xml),
    seconds: Number(/<Parktime>(\d+)/.exec(xml)?.[1]),
    preset: type === 'preset' ? Number(/<ActionNum>(\d+)/.exec(xml)?.[1]) : null,
    action: type,
  };
}

export function setPark(cam, { enabled, seconds = 60, preset = 1 }) {
  const s = Number(seconds), p = Number(preset);
  if (!Number.isInteger(s) || s < 5 || s > 720) throw new Error('seconds must be 5-720');
  if (!Number.isInteger(p) || p < 1 || p > 300) throw new Error('preset must be 1-300');
  return isapi(cam, 'PUT', `/ISAPI/PTZCtrl/channels/${cam.ptz}/parkaction`,
    `<ParkAction><enabled>${Boolean(enabled)}</enabled><Parktime>${s}</Parktime>` +
    `<Action><ActionType>preset</ActionType><ActionNum>${p}</ActionNum></Action></ParkAction>`);
}

/** Point the camera at an exact position, in the same units status() returns. */
export function moveTo(cam, { azimuth, elevation, zoom }) {
  const tenths = (v) => Math.round(Number(v) * 10);
  return isapi(cam, 'PUT', `/ISAPI/PTZCtrl/channels/${cam.ptz}/absolute`,
    `<PTZData><AbsoluteHigh><elevation>${tenths(elevation)}</elevation><azimuth>${tenths(azimuth)}</azimuth><absoluteZoom>${tenths(zoom)}</absoluteZoom></AbsoluteHigh></PTZData>`);
}
