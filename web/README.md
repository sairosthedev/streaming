# Vercel viewer app

The public half of the camera stream. Deploy this to Vercel; run the agent
(`npm run agent`, from the repo root) on the PC that can see the camera.

## Why it's split this way

Vercel runs serverless functions. They cannot run FFmpeg, cannot hold a
connection open, and — the part that decides the whole design — **cannot reach
`192.168.x.x`**. Your camera is on your LAN behind NAT; nothing in Vercel's
datacenter has a route to it.

So Vercel can't pull. The PC has to push:

```
Camera --RTSP--> PC agent --HTTPS--> Vercel Blob <--reads-- Vercel app --> viewers
   (LAN)          (ffmpeg)            (storage)             (this)
```

The agent transcodes to HLS and uploads each segment to Blob. This app reads
from Blob and serves a password-gated player. **The PC must stay on** — it is
the only thing that can see the camera.

## Deploy

**1. Push the repo to GitHub**, then import it at
[vercel.com/new](https://vercel.com/new). Set **Root Directory** to `web`.

**2. Add a Blob store.** In the project: **Storage → Create → Blob**. Vercel
sets `BLOB_READ_WRITE_TOKEN` on the project automatically.

**3. Set two environment variables** (Settings → Environment Variables):

| Name | Value |
| --- | --- |
| `VIEW_PASSWORD` | The password viewers must type. |
| `SESSION_SECRET` | Any long random string. Signs login cookies. |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`SESSION_SECRET` is required in production — the app refuses to start without
it rather than falling back to something guessable.

**4. Deploy.** You get a permanent URL like `your-app.vercel.app`.

**5. Copy the Blob token to your PC.** In the Vercel project, open
**Storage → your Blob store → `.env.local`** and copy `BLOB_READ_WRITE_TOKEN`
into the repo-root `.env`.

**6. Start the agent** on the PC:

```bash
npm run agent
```

Open your Vercel URL, enter the password, and the feed appears. If the agent
isn't running, the page says so rather than spinning forever.

## Cost

Video is heavy. At 1080p you're pushing very roughly **1 GB per hour** through
Blob, and Vercel's free tier is not sized for continuous streaming. The agent
keeps only ~6 segments live and deletes the rest, so *storage* stays flat — but
**bandwidth still accrues on every segment uploaded and every segment watched**.

This design suits *watching on demand* — start the agent when you want to look,
stop it when you're done. Leaving it running 24/7 will cost real money. Watch
your usage in the Vercel dashboard for the first day.

If you want always-on, the self-hosted Cloudflare Tunnel setup in the root
[README](../README.md) has no bandwidth bill at all.

## Notes

- Segments are proxied through `/api/stream/segment/...` rather than served
  from their raw Blob URLs. Blob objects are public to anyone holding the URL,
  so proxying is what makes the password actually gate the *video* and not just
  the page around it.
- Expect ~10s of latency, a little more than the local setup, because segments
  make an extra hop through Blob.
