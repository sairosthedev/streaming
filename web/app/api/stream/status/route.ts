import { NextResponse } from 'next/server';
import { list } from '@vercel/blob';
import { isAuthenticated } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Is the agent currently pushing? The Vercel app can't start the camera — it
 * has no route into the LAN — so all it can do is report whether fresh segments
 * are arriving, and let the UI say "start the agent on your PC" if not.
 */
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let blobs;
  try {
    ({ blobs } = await list({ prefix: 'live/', limit: 100 }));
  } catch (err) {
    // A bad or missing BLOB_READ_WRITE_TOKEN lands here. That's a deployment
    // problem, not a viewer problem — report it as offline rather than a 500,
    // and say so in the logs where whoever deployed it will look.
    console.error('Blob list failed:', err);
    return NextResponse.json({ live: false, reason: 'blob-error' });
  }

  const playlist = blobs.find((b) => b.pathname === 'live/stream.m3u8');

  if (!playlist) {
    return NextResponse.json({ live: false, reason: 'no-agent' });
  }

  // A playlist that stopped being rewritten means the agent died without
  // cleaning up. Treat a stale one as offline rather than showing a frozen frame.
  const ageMs = Date.now() - new Date(playlist.uploadedAt).getTime();
  const stale = ageMs > 30_000;

  return NextResponse.json({
    live: !stale,
    reason: stale ? 'stale' : 'ok',
    ageSeconds: Math.round(ageMs / 1000),
    segments: blobs.filter((b) => b.pathname.endsWith('.ts')).length,
  });
}
