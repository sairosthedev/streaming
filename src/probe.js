/**
 * Diagnostic: can this machine actually reach the camera?
 *
 *   npm run probe
 *
 * Run this first whenever the player shows "No signal". It tells you whether
 * the problem is the camera/network or the browser/player.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { which, installHint } from './which.js';

const RTSP_URL = process.env.RTSP_URL;
const RTSP_TRANSPORT = process.env.RTSP_TRANSPORT || 'tcp';

if (!RTSP_URL || RTSP_URL.includes('username:password')) {
  console.error('RTSP_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const bin = which('ffprobe');
if (!bin) {
  console.error(`\n  ${installHint('ffprobe')}\n`);
  process.exit(1);
}

console.log(`Probing ${RTSP_URL.replace(/\/\/[^@/]*@/, '//***:***@')} over ${RTSP_TRANSPORT}…\n`);

const ffprobe = spawn(bin, [
  '-v', 'error',
  '-rtsp_transport', RTSP_TRANSPORT,
  '-timeout', '10000000',
  '-show_entries', 'stream=codec_name,codec_type,width,height,avg_frame_rate',
  '-of', 'default=noprint_wrappers=1',
  '-i', RTSP_URL,
]);

let out = '';
let err = '';
ffprobe.stdout.on('data', (d) => (out += d));
ffprobe.stderr.on('data', (d) => (err += d));

ffprobe.on('error', (e) => {
  if (e.code === 'ENOENT') {
    console.error('ffprobe not found. Install FFmpeg and open a NEW terminal:');
    console.error('  winget install Gyan.FFmpeg');
    process.exit(1);
  }
  throw e;
});

ffprobe.on('close', (code) => {
  if (code !== 0) {
    console.error('Could not reach the camera.\n');
    console.error(err.trim() || '(no detail from ffprobe)');
    console.error('\nThings to check:');
    console.error('  · Does the exact same URL work in VLC on this machine right now?');
    console.error('  · Username/password correct, and special characters URL-encoded?');
    console.error('      @ -> %40   : -> %3A   / -> %2F   # -> %23');
    console.error('  · Try RTSP_TRANSPORT=udp in .env if tcp fails.');
    process.exit(1);
  }

  console.log(out.trim());

  const codec = /codec_name=(\w+)/.exec(out)?.[1];
  console.log('\nCamera reachable.\n');

  if (codec === 'hevc' || codec === 'h265') {
    console.log('  This camera sends H.265/HEVC, which browsers cannot play.');
    console.log('  Set VIDEO_MODE=transcode in .env — costs CPU but it will work.');
  } else if (codec === 'h264') {
    console.log('  H.264 — browsers play this directly. Keep VIDEO_MODE=copy.');
  }
});
