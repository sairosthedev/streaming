# streaming

Watch an RTSP IP camera from any browser, anywhere.

**Use the self-hosted path.** Your PC serves the video and Cloudflare Tunnel puts
it on a public HTTPS URL. Free, unlimited, no quota:

```
camera -> your PC (ffmpeg) -> Cloudflare Tunnel -> viewers anywhere
```

A Vercel variant also exists (`pc/agent`, deployed app at the repo root), but
**it is not recommended and it is not free.** It relays every byte through Vercel
Blob, and 1080p video is roughly 1 GB/hour — uploaded once, then downloaded again
per viewer. It exhausted the Blob free tier in about an hour of real use. Any
object-storage relay hits the same wall; the problem is the shape, not the
provider.

Either way, **the PC that can see the camera has to stay on.** No cloud service
can reach `192.168.x.x` — your camera is behind NAT on your LAN — so the PC must
always be the source.

## Layout

```
/                 Next.js viewer app -> deployed to Vercel
pc/               everything that runs on the PC by the camera
  src/server.js     self-hosted server (no Vercel needed)
  src/tunnel.js     Cloudflare Tunnel -> public URL
  src/probe.js      "can I reach the camera?"
  agent/index.js    pushes segments to Vercel Blob
.env              camera URL + secrets (gitignored, shared by both)
```

The Next.js app is the repo root because that is what Vercel's defaults expect.
Putting it in a subfolder made Vercel autodetect the PC server's `package.json`
and try to deploy *that* — see the git history for the three ways this failed.

## Setup

```bash
cp .env.example .env      # then put your camera's RTSP URL in it
cd pc && npm install
npm run probe             # confirms the camera is reachable, prints its codec
```

Get `npm run probe` passing before anything else. If it can't reach the camera,
nothing downstream will, and it tells you exactly why.

## Run it

```bash
cd pc
npm start                 # terminal 1 — serves the camera
npm run tunnel            # terminal 2 — prints your public https:// URL
```

Both terminals stay open. Open the URL from anywhere; enter `VIEW_PASSWORD`.

Unlimited: Cloudflare does not bill tunnel bandwidth, and the video never touches
a metered store.

The free URL changes on each restart. For a permanent one on your own domain, see
[pc/README.md](pc/README.md) — it takes about two minutes.

### Settings worth knowing

- `VIEW_PASSWORD` — **set this.** Blank means anyone with the URL can watch.
- `IDLE_TIMEOUT` — seconds to keep streaming after the last viewer leaves
  (default 300). `0` streams continuously. The camera and CPU idle when nobody
  is watching; the page starts the stream on demand.

## Vercel (not recommended)

See [DEPLOY.md](DEPLOY.md). It works, but it relays video through Vercel Blob at
roughly 1 GB/hour, billed on upload *and* on every view — it exhausted the free
tier in about an hour. Use the tunnel above unless you have a specific reason not
to.

## Troubleshooting

**Anything at all** — run `cd pc && npm run probe` first. It isolates "the camera
is unreachable" from every other possible problem.

**Black screen but status says Live** — the camera is sending H.265/HEVC, which
browsers can't decode. `probe` will say so. Set `VIDEO_MODE=transcode` in `.env`.

**Stuttering** — try `RTSP_TRANSPORT=udp` in `.env`.

**`ffmpeg not found`** — `winget install Gyan.FFmpeg`, then open a *new* terminal.
