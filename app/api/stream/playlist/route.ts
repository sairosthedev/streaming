import { NextResponse } from 'next/server';
import { list } from '@vercel/blob';
import { isAuthenticated } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Serve the live playlist.
 *
 * The agent writes real segment names into the playlist it uploads. We rewrite
 * each one to point at our own /api/stream/segment route rather than at the raw
 * Blob URL: Vercel Blob objects are public and unguessable, but a URL that
 * leaks is a URL that works forever. Routing segments through here means the
 * password gate actually gates the video, not just the page around it.
 */
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // The playlist blob's public URL isn't derivable from its pathname, so look
  // it up. It's rewritten every ~2s, so we must never serve a cached copy.
  let playlist;
  try {
    const { blobs } = await list({ prefix: 'live/stream.m3u8', limit: 1 });
    playlist = blobs[0];
  } catch (err) {
    console.error('Blob list failed:', err);
    return NextResponse.json({ error: 'offline' }, { status: 404 });
  }

  if (!playlist) {
    return NextResponse.json({ error: 'offline' }, { status: 404 });
  }

  const res = await fetch(playlist.url, { cache: 'no-store' });
  if (!res.ok) {
    return NextResponse.json({ error: 'offline' }, { status: 404 });
  }

  const body = await res.text();

  const rewritten = body.replace(
    /^(seg\d+\.ts)$/gm,
    (name) => `/api/stream/segment/${name}`,
  );

  return new NextResponse(rewritten, {
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
