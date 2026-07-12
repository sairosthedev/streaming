/**
 * Load the repo-root .env, whatever the working directory.
 *
 * Bare `import 'dotenv/config'` resolves .env against process.cwd(). npm runs
 * these scripts from pc/, but the .env lives at the repo root (shared with the
 * Vercel agent), so the bare import silently finds nothing and every script
 * reports the camera as unconfigured.
 *
 * Import this first, before reading any process.env value.
 */
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

config({ path: path.join(__dirname, '..', '..', '.env') });
