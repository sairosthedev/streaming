/**
 * Find cameras and NVRs on a network you have never seen before.
 *
 *   npm run scan                          look, report, change nothing
 *   npm run scan -- --user admin --pass 'secret'    also test streams
 *   npm run scan -- --user admin --pass 'secret' --add
 *
 * `npm run discover` re-finds cameras you already registered, by MAC. This is
 * the other half: walking into a client site and asking "what is out there?"
 *
 * It cannot guess a password. Nothing can. Credentials come from you, and
 * without them this only reports candidates rather than working stream URLs.
 *
 * Nothing is written to the registry unless you pass --add.
 */
import './env.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { localSubnets, parseNeighbours, normalizeMac } from './discover.js';
import { which } from './which.js';

const exec = promisify(execFile);

/**
 * MAC prefixes belonging to camera makers. Not exhaustive -- there are
 * thousands -- but these cover the gear that actually turns up on sites.
 * A device is still reported when its OUI is unknown: an open 554 is the
 * stronger signal, and white-label cameras use their chipset vendor's OUI.
 */
const VENDOR_OUI = {
  hikvision: ['44:19:b6', 'bc:ad:28', '4c:bd:8f', '58:03:fb', 'e0:50:8b', 'c0:56:e3', '24:0f:9b', '00:11:32', 'a4:14:37', '54:c4:15', '28:57:be', 'bc:32:5f', '48:ea:63'],
  dahua: ['f8:ce:07', '3c:ef:8c', '00:12:12', '90:02:a9', '14:a7:8b', '08:ed:ed', 'e0:61:b2'],
  axis: ['00:40:8c', 'ac:cc:8e', 'b8:a4:4f'],
  uniview: ['48:ea:63', '6c:f1:7e'],
  reolink: ['ec:71:db'],
  amcrest: ['9c:8e:cd'],
  tplink: ['00:31:92', '9c:53:22'],
};

const OUI_TO_VENDOR = (() => {
  const m = new Map();
  for (const [vendor, ouis] of Object.entries(VENDOR_OUI)) {
    for (const o of ouis) if (!m.has(o)) m.set(o, vendor);
  }
  return m;
})();

function vendorOf(mac) {
  const norm = normalizeMac(mac);
  if (!norm) return null;
  return OUI_TO_VENDOR.get(norm.slice(0, 8)) ?? null;
}

/**
 * Stream URL shapes per vendor.
 *
 * `ch` is the NVR channel (1 for a standalone camera). Substreams come first
 * deliberately: they are ~7x fewer pixels, and on a Pi 5 -- which has no
 * hardware H264 encoder -- that is the difference between one camera and ten.
 */
function candidateUrls(vendor, host, user, pass, ch = 1) {
  const cred = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
  const base = `rtsp://${cred}${host}:554`;
  const dahua = [
    `${base}/cam/realmonitor?channel=${ch}&subtype=1`,
    `${base}/cam/realmonitor?channel=${ch}&subtype=0`,
  ];
  const hik = [
    `${base}/Streaming/Channels/${ch}02`,
    `${base}/Streaming/Channels/${ch}01`,
  ];
  if (vendor === 'dahua' || vendor === 'amcrest') return dahua;
  if (vendor === 'hikvision' || vendor === 'uniview') return hik;
  // Unknown vendor: try both shapes, plus the two most common generic paths.
  return [...hik, ...dahua, `${base}/live`, `${base}/stream1`];
}

const PORTS = [554, 80, 8000, 37777, 8554];

function probePort(host, port, timeout = 700) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (open) => {
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

/** Ping the whole /24 so the kernel's ARP table learns who is out there. */
async function sweep(subnets) {
  const args = process.platform === 'win32'
    ? (ip) => ['-n', '1', '-w', '400', ip]
    : (ip) => ['-c', '1', '-W', '1', ip];
  const jobs = [];
  for (const base of subnets) {
    for (let i = 1; i <= 254; i++) {
      jobs.push(exec('ping', args(`${base}.${i}`), { timeout: 3000 }).catch(() => {}));
    }
  }
  await Promise.all(jobs);
}

async function neighbours() {
  const attempts = process.platform === 'win32'
    ? [['arp', ['-a']]]
    : [['ip', ['neigh']], ['arp', ['-a']]];
  let text = '';
  for (const [bin, argv] of attempts) {
    try {
      const { stdout } = await exec(bin, argv, { timeout: 5000 });
      text += '\n' + stdout;
    } catch { /* try the next */ }
  }
  return parseNeighbours(text);
}

/** Does this URL actually yield video? The only answer that counts. */
async function testStream(url, timeoutMs = 12000) {
  const bin = which('ffprobe');
  if (!bin) return { ok: false, why: 'ffprobe not installed' };
  try {
    const { stdout } = await exec(bin, [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height',
      '-of', 'default=noprint_wrappers=1',
      '-i', url,
    ], { timeout: timeoutMs });
    const codec = /codec_name=(\w+)/.exec(stdout)?.[1];
    const width = /width=(\d+)/.exec(stdout)?.[1];
    const height = /height=(\d+)/.exec(stdout)?.[1];
    if (!codec) return { ok: false, why: 'no video stream' };
    return { ok: true, codec, width: Number(width), height: Number(height) };
  } catch (err) {
    const msg = String(err.stderr || err.message || '');
    if (/401|[Uu]nauthorized/.test(msg)) return { ok: false, why: 'bad credentials' };
    if (/timed out|ETIMEDOUT/i.test(msg)) return { ok: false, why: 'timeout' };
    return { ok: false, why: msg.split('\n').find(Boolean)?.slice(0, 80) || 'failed' };
  }
}

const mask = (u) => String(u).replace(/\/\/[^@/]*@/, '//***:***@');

function parseArgs(argv) {
  const out = { user: '', pass: '', add: false, channels: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') out.user = argv[++i] ?? '';
    else if (a === '--pass') out.pass = argv[++i] ?? '';
    else if (a === '--add') out.add = true;
    else if (a === '--channels') out.channels = Math.max(1, Number(argv[++i]) || 1);
  }
  return out;
}

// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const subnets = localSubnets();

if (!subnets.length) {
  console.error('\n  No IPv4 /24 interface found - is this machine on a network?\n');
  process.exit(1);
}

console.log(`\n  Sweeping ${subnets.map((s) => `${s}.0/24`).join(', ')} ...`);
await sweep(subnets);

const table = await neighbours();
const hosts = [...table.entries()].map(([mac, ip]) => ({ mac, ip, vendor: vendorOf(mac) }));
console.log(`  ${hosts.length} device(s) answered.\n`);

console.log('  Checking camera ports...\n');
const candidates = [];
await Promise.all(hosts.map(async (h) => {
  const open = [];
  await Promise.all(PORTS.map(async (p) => {
    if (await probePort(h.ip, p)) open.push(p);
  }));
  if (open.length) candidates.push({ ...h, open: open.sort((a, b) => a - b) });
}));

// An open 554 is the real signal; a known camera OUI is corroboration.
const likely = candidates
  .filter((c) => c.open.includes(554) || c.vendor)
  .sort((a, b) => Number(b.open.includes(554)) - Number(a.open.includes(554)));

if (!likely.length) {
  console.log('  No cameras found.\n');
  console.log('  If you expected some: they may be on another subnet, powered');
  console.log('  off, or holding a static IP this machine cannot route to.\n');
  process.exit(1);
}

console.log('  ip                mac                 vendor      ports');
console.log('  ' + '-'.repeat(62));
for (const c of likely) {
  console.log(
    `  ${c.ip.padEnd(17)} ${c.mac}   ${(c.vendor ?? '?').padEnd(11)} ${c.open.join(',')}`,
  );
}
console.log('');

if (!opts.user || !opts.pass) {
  console.log('  Found the devices. To get working stream URLs, supply credentials:');
  console.log("    npm run scan -- --user admin --pass 'yourpassword'\n");
  console.log('  No password can be discovered by scanning - the client has to tell you.\n');
  process.exit(0);
}

console.log(`  Testing streams as "${opts.user}" (channels 1-${opts.channels})...\n`);
const working = [];

for (const c of likely.filter((x) => x.open.includes(554))) {
  for (let ch = 1; ch <= opts.channels; ch++) {
    let hit = null;
    for (const url of candidateUrls(c.vendor, c.ip, opts.user, opts.pass, ch)) {
      const r = await testStream(url);
      if (r.ok) {
        hit = { ...c, ch, url, ...r };
        break;
      }
      if (r.why === 'bad credentials') {
        console.log(`  ${c.ip} ch${ch}: bad credentials`);
        hit = 'auth';
        break;
      }
    }
    if (hit === 'auth') break;
    if (hit) {
      console.log(`  ${c.ip} ch${ch}: ${hit.codec} ${hit.width}x${hit.height}  ${mask(hit.url)}`);
      working.push(hit);
    } else if (ch === 1) {
      console.log(`  ${c.ip} ch${ch}: no working URL found`);
    }
  }
}

if (!working.length) {
  console.log('\n  Nothing streamed. Check the credentials, or the cameras may use');
  console.log('  a URL shape this does not know yet.\n');
  process.exit(1);
}

console.log(`\n  ${working.length} working stream(s).\n`);

if (!opts.add) {
  console.log('  Nothing was written. To add these to the registry, re-run with --add\n');
  process.exit(0);
}

const { dbConfigured, addCamera, closeDb } = await import('./db.js');
if (!dbConfigured()) {
  console.error('  MONGODB_URI is not set, so there is no registry to add to.\n');
  process.exit(1);
}

let n = 0;
for (const w of working) {
  // H264 passes through untouched; anything else needs re-encoding to be
  // playable in a browser.
  const passthrough = w.codec === 'h264';
  const name = `cam${++n}`;
  try {
    await addCamera({
      name,
      label: `Camera ${n}`,
      rtspUrl: w.url,
      transport: 'tcp',
      transcode: !passthrough,
      mac: w.mac,
    });
    console.log(`  added ${name}  ${passthrough ? 'passthrough' : 'transcode'}  mac ${w.mac}`);
  } catch (err) {
    console.log(`  skipped ${name}: ${err.message}`);
  }
}
await closeDb();
console.log('\n  Restart the server to pick them up.\n');
