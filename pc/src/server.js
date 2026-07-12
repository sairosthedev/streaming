import './env.js';
import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { which, installHint } from './which.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HLS_DIR = path.join(ROOT, 'hls');

const RTSP_URL = process.env.RTSP_URL;
const PORT = Number(process.env.PORT || 8080);
const RTSP_TRANSPORT = process.env.RTSP_TRANSPORT || 'tcp';
const VIEW_PASSWORD = process.env.VIEW_PASSWORD || '';
const VIDEO_MODE = process.env.VIDEO_MODE || 'copy';
const TRANSCODE_BITRATE = process.env.TRANSCODE_BITRATE || '1500k';
const TRANSCODE_SCALE = process.env.TRANSCODE_SCALE || '1280:-2';

if (!RTSP_URL || RTSP_URL.includes('username:password')) {
  console.error('\n  RTSP_URL is not set.\n');
  console.error('  Copy .env.example to .env and put your camera URL in it —');
  console.error('  the same URL you paste into VLC.\n');
  process.exit(1);
}

// Never print the camera password to the console or to a viewer's browser.
const safeUrl = RTSP_URL.replace(/\/\/[^@/]*@/, '//***:***@');

fs.rmSync(HLS_DIR, { recursive: true, force: true });
fs.mkdirSync(HLS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// FFmpeg: pull RTSP, write a rolling HLS playlist. Restarts itself if the
// camera drops off the network, which IP cameras do routinely.
// ---------------------------------------------------------------------------

let ffmpeg = null;
let restartTimer = null;
let shuttingDown = false;
let lastFfmpegError = '';
/** For reconnect backoff: how long the last ffmpeg run survived. */
let ffmpegStartedAt = 0;
let restarts = 0;
/** Set when ffmpeg isn't installed — retrying the spawn would just fail forever. */
let ffmpegMissing = false;

/**
 * Watchers keep ffmpeg alive; with none, it stops after IDLE_TIMEOUT_MS. This
 * spares the camera and the CPU when nobody is looking -- bandwidth is free
 * here, but a 24/7 pull from the camera is not free for the camera.
 *
 * Set IDLE_TIMEOUT=0 in .env to stream continuously regardless of viewers.
 */
let lastViewerAt = Date.now();
const IDLE_TIMEOUT_MS =
  process.env.IDLE_TIMEOUT !== undefined
    ? Number(process.env.IDLE_TIMEOUT) * 1000
    : 300_000;

function ffmpegArgs() {
  const args = ['-hide_banner', '-loglevel', 'error'];

  // These are RTSP-demuxer options; ffmpeg rejects them outright for other inputs.
  if (RTSP_URL.startsWith('rtsp://')) {
    args.push(
      '-rtsp_transport', RTSP_TRANSPORT,
      // Socket I/O timeout in microseconds — 10s for a slow camera to answer.
      // FFmpeg 7 renamed this from -stimeout; -timeout is the current spelling.
      '-timeout', '10000000',
    );
  }

  args.push(
    '-i', RTSP_URL,
    '-an', // no audio: most cameras send none, and a missing track breaks HLS
  );

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
    // Repackage the camera's own H.264 stream. No re-encode, so ~0% CPU.
    args.push('-c:v', 'copy');
  }

  args.push(
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    // delete_segments keeps the folder from growing without bound;
    // append_list + omit_endlist keep the playlist looking live to the player.
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(HLS_DIR, 'seg%03d.ts'),
    path.join(HLS_DIR, 'stream.m3u8'),
  );

  return args;
}

function startFfmpeg() {
  if (ffmpeg || shuttingDown || ffmpegMissing) return;

  const bin = which('ffmpeg');
  if (!bin) {
    ffmpegMissing = true;
    lastFfmpegError = installHint('ffmpeg').replace(/\n\s*/g, ' ');
    console.error(`\n  ${installHint('ffmpeg')}\n`);
    return;
  }

  console.log(`[ffmpeg] connecting to ${safeUrl} (${RTSP_TRANSPORT}, ${VIDEO_MODE})`);
  ffmpegStartedAt = Date.now();
  ffmpeg = spawn(bin, ffmpegArgs(), { windowsHide: true });

  ffmpeg.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (!msg) return;
    lastFfmpegError = msg.split('\n').pop().slice(0, 300);
    console.error('[ffmpeg]', msg);
  });

  ffmpeg.on('error', (err) => {
    ffmpeg = null;

    // Surface this to the viewer rather than killing the server: the page and
    // its assets are already being served, and a hard exit mid-request drops them.
    if (err.code === 'ENOENT') {
      ffmpegMissing = true;
      lastFfmpegError =
        'ffmpeg is not on PATH. Install it (winget install Gyan.FFmpeg), then open a NEW terminal and restart.';
      console.error(`\n  ${lastFfmpegError}\n`);
      return;
    }

    lastFfmpegError = err.message;
    console.error('[ffmpeg] spawn failed:', err.message);
  });

  ffmpeg.on('close', (code) => {
    ffmpeg = null;
    if (shuttingDown || ffmpegMissing) return;

    // A run that produced video was a genuine camera drop (WiFi blip, "bad
    // cseq") -- reconnect promptly. A run that died on startup is a real fault
    // (bad URL, camera off) and retrying it every 3s just spins the CPU, so
    // back off up to 30s.
    const lived = Date.now() - ffmpegStartedAt;
    if (lived > 15_000) restarts = 0;
    else restarts++;

    const delay = Math.min(3000 * 2 ** Math.max(0, restarts - 1), 30_000);

    console.warn(`[ffmpeg] exited (code ${code}) - reconnecting in ${delay / 1000}s`);
    restartTimer = setTimeout(startFfmpeg, delay);
  });
}

function stopFfmpeg() {
  clearTimeout(restartTimer);
  restartTimer = null;
  if (!ffmpeg) return;
  console.log('[ffmpeg] no viewers - stopping (set IDLE_TIMEOUT=0 to stay on)');
  ffmpeg.kill('SIGKILL'); // SIGTERM is a no-op for ffmpeg on Windows
  ffmpeg = null;
}

// Stop pulling from the camera once everyone has closed the page.
// IDLE_TIMEOUT=0 disables this entirely and keeps the stream always-on.
if (IDLE_TIMEOUT_MS > 0) {
  setInterval(() => {
    if (ffmpeg && Date.now() - lastViewerAt > IDLE_TIMEOUT_MS) stopFfmpeg();
  }, 10_000).unref();
}

// ---------------------------------------------------------------------------
// Auth: one shared password, exchanged for a signed cookie.
// ---------------------------------------------------------------------------

const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

function issueToken() {
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(String(expires)).digest('hex');
  return `${expires}.${sig}`;
}

function tokenIsValid(token) {
  if (typeof token !== 'string') return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig) return false;
  if (Number(expires) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(expires).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => {
      const i = c.indexOf('=');
      if (i < 0) return ['', ''];
      return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    }),
  );
}

function requireAuth(req, res, next) {
  if (!VIEW_PASSWORD) return next();
  const { session } = parseCookies(req.headers.cookie);
  if (tokenIsValid(session)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.disable('x-powered-by');
// Cloudflare Tunnel fronts us and terminates TLS; without this, req.secure is
// always false and we'd never mark the session cookie Secure in production.
app.set('trust proxy', true);

app.get('/api/config', (req, res) => {
  const { session } = parseCookies(req.headers.cookie);
  res.json({
    requiresPassword: Boolean(VIEW_PASSWORD),
    authenticated: !VIEW_PASSWORD || tokenIsValid(session),
  });
});

app.post('/api/login', (req, res) => {
  if (!VIEW_PASSWORD) return res.json({ ok: true });

  const supplied = Buffer.from(String(req.body?.password ?? ''));
  const actual = Buffer.from(VIEW_PASSWORD);
  const ok =
    supplied.length === actual.length && crypto.timingSafeEqual(supplied, actual);

  if (!ok) return res.status(401).json({ error: 'Wrong password' });

  // Only mark the cookie Secure when the request actually came over HTTPS —
  // Cloudflare terminates TLS and tells us via x-forwarded-proto. Setting it
  // unconditionally would stop the cookie from ever coming back over plain
  // HTTP on localhost or the LAN, locking the viewer out of their own feed.
  const isHttps =
    req.secure || req.headers['x-forwarded-proto'] === 'https';

  const cookie = [
    `session=${issueToken()}`,
    'HttpOnly',
    'Path=/',
    'Max-Age=604800',
    'SameSite=Lax',
    isHttps ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');

  res.setHeader('Set-Cookie', cookie);
  res.json({ ok: true });
});

// Called by the player on load. Brings FFmpeg up on demand and reports whether
// the first segments have landed yet, so the UI can say "connecting" honestly.
app.get('/api/stream/status', requireAuth, (req, res) => {
  lastViewerAt = Date.now();
  startFfmpeg();

  const playlist = path.join(HLS_DIR, 'stream.m3u8');
  const ready =
    fs.existsSync(playlist) &&
    fs.readdirSync(HLS_DIR).some((f) => f.endsWith('.ts'));

  res.json({ ready, running: Boolean(ffmpeg), error: ready ? '' : lastFfmpegError });
});

app.use(
  '/hls',
  requireAuth,
  (req, res, next) => {
    lastViewerAt = Date.now();
    // The playlist is rewritten every ~2s; a cached copy would freeze playback.
    res.setHeader('Cache-Control', 'no-store');
    next();
  },
  express.static(HLS_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
      }
    },
  }),
);

app.use(express.static(path.join(ROOT, 'public')));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Camera:  ${safeUrl}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Password: ${VIEW_PASSWORD ? 'on' : 'OFF - anyone with the URL can watch'}`);
  console.log(`\n  For a public URL, run this in a second terminal:`);
  console.log(`    npm run tunnel\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.\n`);
    console.error('  The server is probably already running in another terminal —');
    console.error(`  try opening http://localhost:${PORT} first.`);
    console.error(`\n  If not, close the other process or set a different PORT in .env.\n`);
    process.exit(1);
  }
  throw err;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    shuttingDown = true;
    stopFfmpeg();
    process.exit(0);
  });
}
