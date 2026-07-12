# streaming

Watch an RTSP IP camera from any browser, anywhere.

Two ways to run it, sharing one `.env`:

| | Where you run it | URL you get |
| --- | --- | --- |
| **Self-hosted** | your PC serves everything | Cloudflare Tunnel — free, unlimited bandwidth |
| **Vercel** | Vercel serves, your PC feeds it | permanent `*.vercel.app` — costs bandwidth |

Either way, **the PC that can see the camera has to stay on.** Vercel's servers
cannot reach `192.168.x.x` — your camera is behind NAT on your LAN — so nothing
in the cloud can pull from it directly. The PC always has to push.

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

## Self-hosted (free, no third party)

```bash
cd pc
npm start                 # terminal 1
npm run tunnel            # terminal 2 -> prints your public https:// URL
```

Both terminals stay open. The URL changes each restart unless you set up a named
tunnel (see [pc/README.md](pc/README.md)).

## Vercel

See [DEPLOY.md](DEPLOY.md). Short version: deploy this repo (no configuration —
the defaults are correct), add a Blob store, set `VIEW_PASSWORD` and
`SESSION_SECRET`, then run `cd pc && npm run agent` on the PC.

**Video through Blob costs bandwidth** — roughly 1 GB/hour at 1080p, billed on
upload and on viewing. Good for watching on demand; expensive left running 24/7.
The self-hosted path has no bandwidth bill.

## Troubleshooting

**Anything at all** — run `cd pc && npm run probe` first. It isolates "the camera
is unreachable" from every other possible problem.

**Black screen but status says Live** — the camera is sending H.265/HEVC, which
browsers can't decode. `probe` will say so. Set `VIDEO_MODE=transcode` in `.env`.

**Stuttering** — try `RTSP_TRANSPORT=udp` in `.env`.

**`ffmpeg not found`** — `winget install Gyan.FFmpeg`, then open a *new* terminal.
