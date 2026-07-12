import { NextResponse } from 'next/server';
import { list } from '@vercel/blob';
import { isAuthenticated } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { name } = await params;

  // The name lands in a blob path, so constrain it hard rather than trusting it.
  if (!/^seg\d+\.ts$/.test(name)) {
    return NextResponse.json({ error: 'bad segment' }, { status: 400 });
  }

  let blob;
  try {
    const { blobs } = await list({ prefix: `live/${name}`, limit: 1 });
    blob = blobs.find((b) => b.pathname === `live/${name}`);
  } catch (err) {
    console.error('Blob list failed:', err);
    return NextResponse.json({ error: 'gone' }, { status: 404 });
  }

  if (!blob) {
    // Normal at the edges of the live window: the player asked for a segment
    // that has already rolled off. Not an error worth logging.
    return NextResponse.json({ error: 'gone' }, { status: 404 });
  }

  const upstream = await fetch(blob.url);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'gone' }, { status: 404 });
  }

  // Stream it through. Buffering a 1-2 MB segment per request would bloat
  // function memory and delay first byte for no benefit.
  return new NextResponse(upstream.body, {
    headers: {
      'Content-Type': 'video/mp2t',
      // A segment's bytes never change once written, so let the browser keep it.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
