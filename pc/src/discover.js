/**
 * Find a camera by MAC address, whatever IP the network gave it.
 *
 *   npm run discover                 find every registry camera that has a mac
 *   npm run discover -- f8:ce:07:3d:57:39
 *
 * Why MAC and not IP: a camera's IP is whatever DHCP handed out at this site,
 * so it changes every time the box is plugged into a different switch. The MAC
 * is burned into the hardware and never changes. Store the MAC once, resolve
 * the IP fresh on every boot, and the system survives being moved.
 *
 * This CANNOT rescue a camera holding a static IP from another subnet: if the
 * Pi is on 192.168.1.x and the camera still insists on 10.10.10.200, they have
 * no route to each other and no amount of scanning invents one. Set the camera
 * to DHCP in its own config tool -- that is the other half of the fix.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const exec = promisify(execFile);

/** f8-ce-07-..., F8:CE:07:... and f8ce07... all mean the same device. */
export function normalizeMac(mac) {
  const hex = String(mac).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

/** Every IPv4 /24 this machine is actually on, as a base like "192.168.1". */
export function localSubnets() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Only /24 sweeps are practical; a /16 is 65k pings.
      if (a.netmask !== '255.255.255.0') continue;
      out.push(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...new Set(out)];
}

/**
 * Parse the neighbour table into { mac -> ip }.
 *
 * Two formats, because the Pi and a Windows dev box disagree:
 *   Linux  `ip neigh`: 192.168.1.5 dev eth0 lladdr f8:ce:07:3d:57:39 REACHABLE
 *   both   `arp -a`:     192.168.1.5    f8-ce-07-3d-57-39   dynamic
 */
export function parseNeighbours(text) {
  const map = new Map();
  const ipRe = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
  const macRe = /\b([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})\b/;

  for (const line of String(text).split('\n')) {
    const ip = ipRe.exec(line)?.[1];
    const mac = macRe.exec(line)?.[1];
    if (!ip || !mac) continue;

    const norm = normalizeMac(mac);
    if (!norm) continue;
    // Broadcast and multicast rows are not devices we can stream from.
    if (norm === 'ff:ff:ff:ff:ff:ff' || norm.startsWith('01:00:5e')) continue;
    // FAILED entries in `ip neigh` are stale misses, not live neighbours.
    if (/\bFAILED\b/i.test(line)) continue;

    if (!map.has(norm)) map.set(norm, ip);
  }
  return map;
}

async function readNeighbours() {
  // `ip neigh` first: on Linux it is the real kernel table. `arp -a` is the
  // portable fallback and the only option on Windows.
  const attempts = os.platform() === 'win32'
    ? [['arp', ['-a']]]
    : [['ip', ['neigh']], ['arp', ['-a']]];

  let text = '';
  for (const [bin, args] of attempts) {
    try {
      const { stdout } = await exec(bin, args, { timeout: 5000 });
      text += '\n' + stdout;
    } catch {
      // Missing binary or non-zero exit: try the next one.
    }
  }
  return parseNeighbours(text);
}

/**
 * Ping every address on our /24s so the kernel populates its ARP table.
 *
 * Without this the table only holds devices we happened to talk to recently,
 * which on a freshly booted Pi is close to nothing -- the camera would be
 * invisible purely because no one had addressed it yet.
 */
async function primeArp(subnets) {
  const pingArgs = os.platform() === 'win32'
    ? (ip) => ['-n', '1', '-w', '400', ip]
    : (ip) => ['-c', '1', '-W', '1', ip];

  const jobs = [];
  for (const base of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${base}.${i}`;
      jobs.push(exec('ping', pingArgs(ip), { timeout: 3000 }).catch(() => {}));
    }
  }
  await Promise.all(jobs);
}

/**
 * Resolve MACs to current IPs. Reads the table first and only sweeps if
 * something is still missing -- the common restart case costs no scan at all.
 *
 * @param {string[]} macs
 * @returns {Promise<Map<string,string>>} normalized mac -> ip (found only)
 */
export async function resolveMacs(macs) {
  const want = new Set(macs.map(normalizeMac).filter(Boolean));
  if (!want.size) return new Map();

  const hit = (table) => {
    const found = new Map();
    for (const mac of want) if (table.has(mac)) found.set(mac, table.get(mac));
    return found;
  };

  let found = hit(await readNeighbours());
  if (found.size === want.size) return found;

  await primeArp(localSubnets());
  found = hit(await readNeighbours());
  return found;
}

/** Swap the host in an RTSP URL, preserving credentials, port, path and query. */
export function withHost(rtspUrl, ip) {
  // Not URL-parsed: camera passwords routinely contain characters that make
  // new URL() throw, and a discovery helper must not be the thing that breaks
  // on a legal password.
  //
  // The credential group is GREEDY up to the last '@' before the host. A
  // non-greedy [^@/]*@ stops at the first '@', so a password like "p@ss" is
  // silently truncated -- taking half the password with it.
  return String(rtspUrl).replace(
    /^(rtsp:\/\/(?:.*@)?)([^/:?@]+)/i,
    (_, prefix) => prefix + ip,
  );
}

/** The host currently written into an RTSP URL, or null. */
export function hostOf(rtspUrl) {
  return /^rtsp:\/\/(?:.*@)?([^/:?@]+)/i.exec(String(rtspUrl))?.[1] ?? null;
}

/**
 * Re-point cameras at wherever their MAC currently lives.
 *
 * Cameras without a `mac` are left exactly as they are: discovery is opt-in
 * per camera, so adding it cannot break a working fixed-IP setup.
 *
 * @returns {Promise<{changed:{name:string,from:string,to:string}[], missing:string[]}>}
 */
export async function rediscover(cameras) {
  const withMac = cameras.filter((c) => normalizeMac(c.mac));
  if (!withMac.length) return { changed: [], missing: [] };

  const found = await resolveMacs(withMac.map((c) => c.mac));
  const changed = [];
  const missing = [];

  for (const cam of withMac) {
    const ip = found.get(normalizeMac(cam.mac));
    if (!ip) {
      missing.push(cam.name);
      continue;
    }
    const from = hostOf(cam.rtspUrl);
    if (from === ip) continue;
    const to = withHost(cam.rtspUrl, ip);
    cam.rtspUrl = to;
    changed.push({ name: cam.name, from, to: ip });
  }
  return { changed, missing };
}

// ---------------------------------------------------------------------------
// CLI: `npm run discover [mac]`
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const arg = process.argv[2];
  const subnets = localSubnets();
  console.log(`\n  Scanning ${subnets.map((s) => s + '.0/24').join(', ') || '(no /24 interface)'}\n`);

  let macs = [];
  if (arg) {
    macs = [arg];
  } else {
    const { dbConfigured, listAll, closeDb } = await import('./db.js');
    if (!dbConfigured()) {
      console.error('  MONGODB_URI is not set, and no MAC was given.\n');
      process.exit(1);
    }
    const all = await listAll();
    macs = all.map((c) => c.mac).filter(Boolean);
    await closeDb();
    if (!macs.length) {
      console.error('  No camera in the registry has a mac yet. Set one:');
      console.error('    npm run cameras -- set-mac <name> f8:ce:07:3d:57:39\n');
      process.exit(1);
    }
  }

  const found = await resolveMacs(macs);
  for (const mac of macs) {
    const norm = normalizeMac(mac);
    if (!norm) {
      console.log(`  ${mac.padEnd(20)} not a MAC address`);
      continue;
    }
    console.log(`  ${norm}   ${found.get(norm) ?? 'NOT FOUND on this network'}`);
  }
  console.log('');
  process.exit(found.size ? 0 : 1);
}
