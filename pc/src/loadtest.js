/**
 * Measure what the transcode actually costs this machine.
 *
 *   npm run loadtest            (60 samples, 5s apart = 5 minutes)
 *   npm run loadtest -- 720     (720 samples = 1 hour)
 *
 * Run this with `npm start` already running and a browser watching the stream.
 * It answers the question the Raspberry Pi migration hinges on: how many
 * cameras fit on this box?
 *
 * CPU percentage alone is misleading on a Pi. A Pi 5 has no hardware H264
 * encoder, so libx264 runs on the CPU, heats the SoC, and the firmware quietly
 * drops the clock at ~80C. A run that looks like "60% CPU" while throttled is
 * really a box already past its limit. So this samples temperature and the
 * firmware's own throttle flags too, and says plainly which limit you hit.
 */
import './env.js';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const samples = Number(process.argv[2] || 60);
const INTERVAL_MS = 5000;

const isLinux = os.platform() === 'linux';
const CORES = os.cpus().length;

/** Total/idle jiffies across all cores, from the kernel. Linux only. */
function readCpuJiffies() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = v[3] + (v[4] || 0); // idle + iowait
  return { total: v.reduce((a, b) => a + b, 0), idle };
}

/**
 * CPU busy % since the previous call. Sampling the delta between two reads is
 * the only honest way -- /proc/stat is cumulative since boot, so a single read
 * gives you the average since power-on, not what is happening now.
 */
let prev = null;
function cpuPercent() {
  if (!isLinux) return null;
  const now = readCpuJiffies();
  if (!prev) {
    prev = now;
    return null;
  }
  const dTotal = now.total - prev.total;
  const dIdle = now.idle - prev.idle;
  prev = now;
  if (dTotal <= 0) return null;
  return (100 * (dTotal - dIdle)) / dTotal;
}

function socTemp() {
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    return Number(raw.trim()) / 1000;
  } catch {
    return null;
  }
}

/**
 * The firmware's throttle bitmask. Bits 0-3 are happening now, bits 16-19 are
 * "has happened since boot". We report the live ones: a run that never sets
 * them is a run the Pi sustained honestly.
 */
function throttled() {
  try {
    const out = execFileSync('vcgencmd', ['get_throttled'], { encoding: 'utf8' });
    const bits = parseInt(out.trim().replace('throttled=', ''), 16);
    if (Number.isNaN(bits)) return null;
    return {
      bits,
      underVoltage: Boolean(bits & 0x1),
      capped: Boolean(bits & 0x2),
      throttled: Boolean(bits & 0x4),
      softTempLimit: Boolean(bits & 0x8),
    };
  } catch {
    return null; // not a Pi, or vcgencmd absent
  }
}

/** ffmpeg CPU share, so we can separate the transcode from everything else. */
function ffmpegPercent() {
  if (!isLinux) return null;
  try {
    const out = execFileSync('ps', ['-C', 'ffmpeg', '-o', '%cpu='], { encoding: 'utf8' });
    const vals = out.trim().split('\n').filter(Boolean).map(Number);
    if (!vals.length) return 0;
    return vals.reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

if (!isLinux) {
  console.log(`\n  Note: full metrics (CPU, temperature, throttling) are Linux-only.`);
  console.log(`  Run this on the Raspberry Pi -- on ${os.platform()} it can only count ffmpegs.\n`);
}

console.log(`\n  Sampling every ${INTERVAL_MS / 1000}s x ${samples} (~${Math.round((samples * INTERVAL_MS) / 60000)} min)`);
console.log(`  Cores: ${CORES}   Stop early with Ctrl-C -- the summary still prints.\n`);
console.log('  elapsed   cpu%   ffmpeg%    temp   throttle');
console.log('  ' + '-'.repeat(46));

const cpuSeries = [];
const tempSeries = [];
let sawThrottle = false;
let sawUnderVoltage = false;
const started = Date.now();

function summary() {
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const max = (a) => (a.length ? Math.max(...a) : null);
  const fmt = (v, u = '') => (v === null ? 'n/a' : v.toFixed(1) + u);

  console.log('\n  ' + '-'.repeat(46));
  console.log(`  Samples:     ${cpuSeries.length}`);
  console.log(`  CPU avg:     ${fmt(avg(cpuSeries), '%')}   peak ${fmt(max(cpuSeries), '%')}`);
  console.log(`  Temp avg:    ${fmt(avg(tempSeries), 'C')}   peak ${fmt(max(tempSeries), 'C')}`);

  const peakCpu = max(cpuSeries);
  const peakTemp = max(tempSeries);

  console.log('');
  if (sawUnderVoltage) {
    console.log('  UNDER-VOLTAGE detected. The power supply is inadequate -- readings');
    console.log('  from this run are not trustworthy. Use the official 27W USB-C PSU.');
  } else if (sawThrottle) {
    console.log('  THROTTLED. The Pi hit its thermal limit and dropped clock speed.');
    console.log('  Add active cooling before drawing conclusions -- this box can do');
    console.log('  more than this run suggests.');
  } else if (peakCpu !== null && peakCpu > 85) {
    console.log('  At the limit: no headroom for a second camera at this setting.');
    console.log('  Use the camera substream (subtype=1) to cut the pixel count ~7x.');
  } else if (peakCpu !== null) {
    // Rough, honest arithmetic: how many of this same camera would fit, leaving
    // 20% for the OS, MediaMTX and the viewers themselves.
    const perCam = peakCpu;
    const fits = Math.max(1, Math.floor(80 / perCam));
    console.log(`  Sustained cleanly, no throttling${peakTemp !== null ? ` (peak ${peakTemp.toFixed(0)}C)` : ''}.`);
    console.log(`  At ~${perCam.toFixed(0)}% per camera, roughly ${fits} camera(s) fit before saturating.`);
    if (fits < 11) {
      console.log(`  The 11-camera NVR will not fit at this quality -- use substreams.`);
    }
  }
  console.log('');
}

let n = 0;
const timer = setInterval(() => {
  const cpu = cpuPercent();
  const temp = socTemp();
  const th = throttled();
  const ff = ffmpegPercent();

  // The very first tick has no previous jiffy reading to diff against.
  if (cpu === null && isLinux && n === 0) return;

  if (cpu !== null) cpuSeries.push(cpu);
  if (temp !== null) tempSeries.push(temp);
  if (th?.throttled || th?.capped || th?.softTempLimit) sawThrottle = true;
  if (th?.underVoltage) sawUnderVoltage = true;

  const flags = th
    ? [th.underVoltage && 'UNDERVOLT', th.throttled && 'THROTTLED', th.capped && 'CAPPED'].filter(Boolean).join(',') || 'ok'
    : 'n/a';

  const el = Math.round((Date.now() - started) / 1000);
  console.log(
    `  ${String(el + 's').padEnd(9)} ${(cpu === null ? 'n/a' : cpu.toFixed(1)).padStart(5)} ` +
      `${(ff === null ? 'n/a' : ff.toFixed(0)).padStart(8)} ` +
      `${(temp === null ? 'n/a' : temp.toFixed(1) + 'C').padStart(7)}   ${flags}`,
  );

  if (++n >= samples) {
    clearInterval(timer);
    summary();
    process.exit(0);
  }
}, INTERVAL_MS);

process.on('SIGINT', () => {
  clearInterval(timer);
  summary();
  process.exit(0);
});
