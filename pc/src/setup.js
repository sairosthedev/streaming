/**
 * Fetch the MediaMTX binary.
 *
 *   npm run setup
 *
 * It is ~30 MB, so it is gitignored rather than committed. Run this once after
 * cloning; `npm start` will tell you to if it is missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, '..', 'bin');

const VERSION = '1.9.3';

const PLATFORM = {
  win32: { x64: 'windows_amd64', arm64: 'windows_amd64' },
  linux: { x64: 'linux_amd64', arm64: 'linux_arm64v8' },
  darwin: { x64: 'darwin_amd64', arm64: 'darwin_arm64' },
}[os.platform()]?.[os.arch()];

if (!PLATFORM) {
  console.error(`\n  No MediaMTX build for ${os.platform()}/${os.arch()}.`);
  console.error('  Download it yourself and put it in pc/bin/:');
  console.error('    https://github.com/bluenviron/mediamtx/releases\n');
  process.exit(1);
}

const exe = os.platform() === 'win32' ? 'mediamtx.exe' : 'mediamtx';

if (fs.existsSync(path.join(BIN_DIR, exe))) {
  console.log('\n  MediaMTX is already installed.\n');
  process.exit(0);
}

const ext = os.platform() === 'win32' ? 'zip' : 'tar.gz';
const url = `https://github.com/bluenviron/mediamtx/releases/download/v${VERSION}/mediamtx_v${VERSION}_${PLATFORM}.${ext}`;

console.log(`\n  Downloading MediaMTX v${VERSION} (~30 MB)...`);

fs.mkdirSync(BIN_DIR, { recursive: true });

const archive = path.join(BIN_DIR, `mediamtx.${ext}`);

const res = await fetch(url);
if (!res.ok) {
  console.error(`\n  Download failed: ${res.status} ${url}\n`);
  process.exit(1);
}

fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

// Use the OS's own extractor rather than adding a dependency for one call.
const unpack =
  ext === 'zip'
    ? spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Path "${archive}" -DestinationPath "${BIN_DIR}" -Force`],
        { stdio: 'inherit' },
      )
    : spawnSync('tar', ['-xzf', archive, '-C', BIN_DIR], { stdio: 'inherit' });

fs.rmSync(archive, { force: true });

if (unpack.status !== 0 || !fs.existsSync(path.join(BIN_DIR, exe))) {
  console.error('\n  Could not unpack MediaMTX.\n');
  process.exit(1);
}

if (os.platform() !== 'win32') {
  fs.chmodSync(path.join(BIN_DIR, exe), 0o755);
}

console.log('  Done. Now run: npm start\n');
