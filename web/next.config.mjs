import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The repo root has its own lockfile (for the PC agent), so Next guesses the
  // wrong workspace root and warns. This app is self-contained in web/.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
