/**
 * Put the local server on a public HTTPS URL via Cloudflare Tunnel.
 *
 *   npm run tunnel
 *
 * Two modes, chosen by .env:
 *
 * - TUNNEL_NAME + TUNNEL_HOSTNAME set: run that named tunnel. The URL is
 *   permanent (e.g. https://camera.titancctv.xyz) and never changes across
 *   restarts. Requires the one-time setup: `cloudflared tunnel login`,
 *   `cloudflared tunnel create <name>`, `cloudflared tunnel route dns <name> <hostname>`.
 *
 * - Otherwise: a quick tunnel with a random trycloudflare.com URL that changes
 *   on every restart. Zero setup, good for trying things out.
 */
import './env.js';
import { spawn } from 'node:child_process';
import { which, installHint } from './which.js';

const PORT = Number(process.env.PORT || 8080);
const HAS_PASSWORD = Boolean(process.env.VIEW_PASSWORD);
const TUNNEL_NAME = process.env.TUNNEL_NAME || '';
const TUNNEL_HOSTNAME = process.env.TUNNEL_HOSTNAME || '';

const named = Boolean(TUNNEL_NAME && TUNNEL_HOSTNAME);

const bin = which('cloudflared');
if (!bin) {
  console.error(`\n  ${installHint('cloudflared')}\n`);
  process.exit(1);
}

const args = named
  ? ['tunnel', 'run', '--url', `http://localhost:${PORT}`, TUNNEL_NAME]
  : ['tunnel', '--url', `http://localhost:${PORT}`];

console.log(
  named
    ? `\n  Starting tunnel "${TUNNEL_NAME}" -> http://localhost:${PORT} ...\n`
    : `\n  Opening a quick tunnel to http://localhost:${PORT} ...\n`,
);

const proc = spawn(bin, args, { windowsHide: true });

let announced = false;
const startupLog = [];

function announce(url) {
  announced = true;
  // ASCII only: the default Windows console code page renders box-drawing
  // characters as mojibake, which makes the URL harder to read, not easier.
  const rule = '='.repeat(url.length + 4);
  console.log(`  ${rule}`);
  console.log(`    ${url}`);
  console.log(`  ${rule}\n`);
  if (named) {
    console.log('  This URL is PERMANENT - it is the same on every restart.');
  } else {
    console.log('  Open that from anywhere - phone, another network, a friend.');
  }
  console.log(
    HAS_PASSWORD
      ? `  Viewers need the password: ${process.env.VIEW_PASSWORD}\n`
      : '  NO PASSWORD SET - anyone with this link can watch your camera.\n',
  );
  console.log('  Keep this window open. Closing it takes the feed offline.\n');
}

function scan(chunk) {
  const text = chunk.toString();

  if (!announced) {
    startupLog.push(text);
    if (startupLog.length > 100) startupLog.shift();

    if (named) {
      // A named tunnel never prints its hostname; it logs connection
      // registrations instead. First registered connection = live.
      if (/Registered tunnel connection/i.test(text)) {
        announce(`https://${TUNNEL_HOSTNAME}`);
        return;
      }
    } else {
      const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0];
      if (url) {
        announce(url);
        return;
      }
    }
  }
}

proc.stdout.on('data', scan);
proc.stderr.on('data', scan);

proc.on('close', (code) => {
  // Died before going live: show cloudflared's own output, which names the
  // actual problem (missing credentials, DNS, auth, ...).
  if (!announced && code) {
    process.stderr.write(`\n${startupLog.join('')}\n`);
    if (named) {
      console.error(
        `  The named tunnel "${TUNNEL_NAME}" could not start. If this is a machine that\n` +
          '  has not run this tunnel before, copy cert.pem and the <tunnel-id>.json\n' +
          '  credentials file from the .cloudflared folder in the home directory of the\n' +
          '  machine where you ran "cloudflared tunnel create" into the .cloudflared\n' +
          '  folder in this machine\'s home directory, then retry.\n',
      );
    }
  }
  console.log(`\n  Tunnel closed (code ${code}). The public URL no longer works.\n`);
  process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    proc.kill();
    process.exit(0);
  });
}
