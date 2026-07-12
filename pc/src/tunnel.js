/**
 * Put the local server on a public HTTPS URL via Cloudflare Tunnel.
 *
 *   npm run tunnel
 *
 * Run this alongside `npm start`. cloudflared buries the URL in its log output,
 * so we pull it out and print it on its own.
 */
import './env.js';
import { spawn } from 'node:child_process';
import { which, installHint } from './which.js';

const PORT = Number(process.env.PORT || 8080);
const HAS_PASSWORD = Boolean(process.env.VIEW_PASSWORD);

const bin = which('cloudflared');
if (!bin) {
  console.error(`\n  ${installHint('cloudflared')}\n`);
  process.exit(1);
}

console.log(`\n  Opening a public tunnel to http://localhost:${PORT} ...\n`);

const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`], {
  windowsHide: true,
});

let announced = false;

function scan(chunk) {
  const text = chunk.toString();

  // cloudflared logs to stderr; the URL shows up once the tunnel is registered.
  const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0];
  if (url && !announced) {
    announced = true;
    // ASCII only: the default Windows console code page renders box-drawing
    // characters as mojibake, which makes the URL harder to read, not easier.
    const rule = '='.repeat(url.length + 4);
    console.log(`  ${rule}`);
    console.log(`    ${url}`);
    console.log(`  ${rule}\n`);
    console.log('  Open that from anywhere - phone, another network, a friend.');
    console.log(
      HAS_PASSWORD
        ? `  Viewers need the password: ${process.env.VIEW_PASSWORD}\n`
        : '  NO PASSWORD SET - anyone with this link can watch your camera.\n',
    );
    console.log('  Keep this window open. Closing it takes the URL down.\n');
    return;
  }

  // Surface real errors; drop cloudflared's routine chatter.
  if (/ERR|error|failed/i.test(text) && !announced) process.stderr.write(text);
}

proc.stdout.on('data', scan);
proc.stderr.on('data', scan);

proc.on('close', (code) => {
  console.log(`\n  Tunnel closed (code ${code}). The public URL no longer works.\n`);
  process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    proc.kill();
    process.exit(0);
  });
}
