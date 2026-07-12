import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';

const COOKIE = 'session';
const MAX_AGE = 7 * 24 * 60 * 60; // seconds

/**
 * Serverless functions are stateless and short-lived, so a per-process random
 * secret would invalidate every session the moment Vercel spun up a new
 * instance. It has to come from the environment.
 *
 * In dev we fall back to an ephemeral secret so `next dev` runs without setup;
 * in production a missing secret is a hard error rather than a silent downgrade
 * to something guessable.
 */
function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s) return s;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is not set');
  }

  devSecret ??= randomBytes(32).toString('hex');
  return devSecret;
}
let devSecret: string | undefined;

function sign(value: string): string {
  return createHmac('sha256', secret()).update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function issueToken(): string {
  const expires = Date.now() + MAX_AGE * 1000;
  return `${expires}.${sign(String(expires))}`;
}

export function tokenIsValid(token: string | undefined): boolean {
  if (!token) return false;

  const [expires, sig] = token.split('.');
  if (!expires || !sig) return false;
  if (Number(expires) < Date.now()) return false;

  return safeEqual(sig, sign(expires));
}

/** Is the password gate switched on at all? */
export function passwordRequired(): boolean {
  return Boolean(process.env.VIEW_PASSWORD);
}

export function checkPassword(supplied: unknown): boolean {
  const expected = process.env.VIEW_PASSWORD;
  if (!expected) return true;
  if (typeof supplied !== 'string') return false;
  return safeEqual(supplied, expected);
}

export async function isAuthenticated(): Promise<boolean> {
  if (!passwordRequired()) return true;
  const jar = await cookies();
  return tokenIsValid(jar.get(COOKIE)?.value);
}

export async function setSessionCookie(): Promise<void> {
  // Mark the cookie Secure only when the request actually arrived over HTTPS.
  // Keying this off NODE_ENV instead would set Secure on any production build,
  // including one served over plain HTTP — where the browser then refuses to
  // send the cookie back, and a correct password still leaves you locked out.
  // On Vercel this is always https, so nothing is lost.
  const h = await headers();
  const proto = h.get('x-forwarded-proto');
  const isHttps = proto ? proto.split(',')[0].trim() === 'https' : false;

  const jar = await cookies();
  jar.set(COOKIE, issueToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    path: '/',
    maxAge: MAX_AGE,
  });
}
