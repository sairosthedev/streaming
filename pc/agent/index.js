/**
 * Camera agent — runs on the PC that can see the camera.
 *
 *   npm run agent
 *
 * FFmpeg pulls RTSP and writes HLS segments to a local folder. We watch that
 * folder and push each new segment to Vercel Blob, then push the playlist that
 * references them. The Vercel app reads from Blob, so it never needs a route
 * into your LAN — which it cannot have.
 *
 * Ordering matters: a playlist naming a segment that hasn't finished uploading
 * gives the player a 404. So segments upload first, and the playlist we publish
 * only ever lists segments already confirmed up.
 */
import '../src/env.js';
import { put, del, list } from '@vercel/blob';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which, installHint } from '../src/which.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORK_DIR = path.join(__dirname, '..', '.agent-hls');

const RTSP_URL = process.env.RTSP_URL;
const RTSP_TRANSPORT = process.env.RTSP_TRANSPORT || 'tcp';
const VIDEO_MODE = process.env.VIDEO_MODE || 'copy';
const TRANSCODE_BITRATE = process.env.TRANSCODE_BITRATE || '1500k';
const TRANSCODE_SCALE = process.env.TRANSCODE_SCALE || '1280:-2';
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// Keep this many segments live. Older ones are deleted from Blob so storage
// (and your bill) stays flat instead of growing forever.
const WINDOW = 6;

if (!RTSP_URL || RTSP_URL.includes('username:password')) {
  console.error('\n  RTSP_URL is not set in .env\n');
  process.exit(1);
}
if (!TOKEN) {
  console.error('\n  BLOB_READ_WRITE_TOKEN is not set in .env');
  console.error('  Get it from your Vercel project: Storage > Blob > .env.local tab.\n');
  process.exit(1);
}

const safeUrl = RTSP_URL.replace(/\/\/[^@/]*@/, '//***:***@');

fs.rmSync(WORK_DIR, { recursive: true, force: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// FFmpeg
// ---------------------------------------------------------------------------

function ffmpegArgs() {
  const args = ['-hide_banner', '-loglevel', 'error'];

  if (RTSP_URL.startsWith('rtsp://')) {
    args.push('-rtsp_transport', RTSP_TRANSPORT, '-timeout', '10000000');
  }

  args.push('-i', RTSP_URL, '-an');

  if (VIDEO_MODE === 'transcode') {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-b:v', TRANSCODE_BITRATE,
      '-vf', `scale=${TRANSCODE_SCALE}`,
      '-g', '50',
    );
  } else {
    args.push('-c:v', 'copy');
  }

  args.push(
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', String(WINDOW),
    // No delete_segments: we delete from Blob ourselves, and we need the local
    // file to still exist when we get around to uploading it.
    '-hls_flags', 'append_list+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(WORK_DIR, 'seg%05d.ts'),
    path.join(WORK_DIR, 'local.m3u8'),
  );

  return args;
}

const bin = which('ffmpeg');
if (!bin) {
  console.error(`\n  ${installHint('ffmpeg')}\n`);
  process.exit(1);
}

console.log(`\n  Camera:  ${safeUrl}`);
console.log(`  Mode:    ${VIDEO_MODE} over ${RTSP_TRANSPORT}`);
console.log(`  Target:  Vercel Blob\n`);
console.log(`  Connecting...\n`);

const ffmpeg = spawn(bin, ffmpegArgs(), { windowsHide: true });
ffmpeg.stderr.on('data', (d) => {
  const m = d.toString().trim();
  if (m) console.error('[ffmpeg]', m);
});
ffmpeg.on('close', (code) => {
  console.error(`\n  ffmpeg exited (code ${code}). Stopping.\n`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Upload loop
// ---------------------------------------------------------------------------

/** Segment filenames confirmed uploaded, oldest first. */
const uploaded = [];
const inFlight = new Set();
let firstPublish = true;

async function uploadSegment(name) {
  const file = path.join(WORK_DIR, name);

  // ffmpeg writes the segment incrementally. Uploading while it's still being
  // written ships a truncated file, so wait for the size to stop changing.
  let prev = -1;
  for (let i = 0; i < 30; i++) {
    let size;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      return false; // vanished
    }
    if (size > 0 && size === prev) break;
    prev = size;
    await sleep(150);
  }

  const body = await fsp.readFile(file);

  await put(`live/${name}`, body, {
    access: 'public',
    token: TOKEN,
    contentType: 'video/mp2t',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 31536000, // a segment's bytes never change
  });

  return true;
}

/** seg00042.ts -> 42 */
function segNumber(name) {
  return Number(name.match(/(\d+)/)[1]);
}

/**
 * Publish a playlist listing only segments we've confirmed are in Blob.
 * The player polls this; it must never name a segment that 404s.
 */
async function publishPlaylist() {
  // Segments upload concurrently and finish out of order, so `uploaded` is in
  // completion order, not stream order. HLS requires strictly ascending
  // segments -- publishing them shuffled makes the player jump around in time.
  // Sort by segment number and take the newest WINDOW.
  const live = [...uploaded].sort((a, b) => segNumber(a) - segNumber(b)).slice(-WINDOW);
  if (!live.length) return;

  // MEDIA-SEQUENCE must equal the number of the first listed segment, or the
  // player will re-download old segments and stall.
  const mediaSequence = segNumber(live[0]);

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:3',
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
  ];

  for (const name of live) {
    lines.push('#EXTINF:2.000000,', name);
  }

  await put('live/stream.m3u8', lines.join('\n') + '\n', {
    access: 'public',
    token: TOKEN,
    contentType: 'application/vnd.apple.mpegurl',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0, // rewritten every ~2s; caching it freezes playback
  });

  if (firstPublish) {
    firstPublish = false;
    console.log('  Live. Open your Vercel app to watch.\n');
  }
}

/** Drop segments that have rolled out of the window, so Blob doesn't grow forever. */
async function prune() {
  while (uploaded.length > WINDOW + 2) {
    // Evict the oldest by segment number, not by upload-completion order --
    // uploads finish out of order, so shifting the array could delete a newer
    // segment and leave an older one live.
    const oldest = uploaded.reduce((a, b) => (segNumber(a) <= segNumber(b) ? a : b));
    uploaded.splice(uploaded.indexOf(oldest), 1);

    try {
      await del(`live/${oldest}`, { token: TOKEN });
    } catch {
      // A failed delete costs a little storage; it must not break the stream.
    }
    await fsp.rm(path.join(WORK_DIR, oldest), { force: true }).catch(() => {});
  }
}

async function tick() {
  let names;
  try {
    names = (await fsp.readdir(WORK_DIR)).filter((f) => f.endsWith('.ts')).sort();
  } catch {
    return;
  }

  for (const name of names) {
    if (uploaded.includes(name) || inFlight.has(name)) continue;

    inFlight.add(name);
    try {
      if (await uploadSegment(name)) {
        uploaded.push(name);
        await publishPlaylist();
        await prune();
      }
    } catch (err) {
      console.error(`  upload failed (${name}): ${err.message}`);
    } finally {
      inFlight.delete(name);
    }
  }
}

const timer = setInterval(() => {
  tick().catch((e) => console.error('  ' + e.message));
}, 500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shutdown() {
  clearInterval(timer);
  ffmpeg.kill('SIGKILL');
  console.log('\n  Stopping — clearing Blob...');
  try {
    const { blobs } = await list({ prefix: 'live/', token: TOKEN });
    await Promise.all(blobs.map((b) => del(b.url, { token: TOKEN }).catch(() => {})));
    console.log('  Cleared.\n');
  } catch {
    console.log('  (could not clear Blob)\n');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
