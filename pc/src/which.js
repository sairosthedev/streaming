/**
 * Locate ffmpeg / ffprobe / cloudflared.
 *
 * Windows installers add these to the machine PATH, but any terminal opened
 * *before* the install keeps a stale copy of PATH and reports "not recognized".
 * Rather than telling people to reopen their terminal, look in the standard
 * install locations ourselves.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

/** Where winget/choco/scoop put these on Windows. */
const WINDOWS_HINTS = {
  ffmpeg: [
    path.join(HOME, 'AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe'),
    'C:/ProgramData/chocolatey/bin/ffmpeg.exe',
    path.join(HOME, 'scoop/shims/ffmpeg.exe'),
  ],
  ffprobe: [
    path.join(HOME, 'AppData/Local/Microsoft/WinGet/Links/ffprobe.exe'),
    'C:/ProgramData/chocolatey/bin/ffprobe.exe',
    path.join(HOME, 'scoop/shims/ffprobe.exe'),
  ],
  cloudflared: [
    'C:/Program Files (x86)/cloudflared/cloudflared.exe',
    'C:/Program Files/cloudflared/cloudflared.exe',
    path.join(HOME, 'AppData/Local/Microsoft/WinGet/Links/cloudflared.exe'),
    'C:/ProgramData/chocolatey/bin/cloudflared.exe',
  ],
};

/**
 * Resolve a binary to something spawnable, or return null if it isn't installed.
 * Prefers PATH; falls back to known install dirs.
 */
export function which(name) {
  // On PATH already? Then the bare name is spawnable and we're done.
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true });
    return name;
  } catch (err) {
    // Anything other than "not found" means it IS there but disliked our probe
    // flag (cloudflared wants --version). Still spawnable.
    if (err.code !== 'ENOENT') return name;
  }

  for (const candidate of WINDOWS_HINTS[name] ?? []) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** Human-readable install hint for a missing binary. */
export function installHint(name) {
  const pkg = name === 'cloudflared' ? 'Cloudflare.cloudflared' : 'Gyan.FFmpeg';
  return `${name} not found. Install it with:\n    winget install ${pkg}\n  then open a NEW terminal.`;
}
