# streaming

Watch your RTSP IP camera from any browser, anywhere — someone opens a URL and the
live feed plays. No VLC, no app install, works on phones.

```
IP camera ──RTSP──> FFmpeg ──HLS──> Node server ──HTTPS──> Cloudflare ──> any browser
```

Browsers can't play RTSP, so FFmpeg repackages the camera's stream into HLS — the same
format YouTube and Twitch use. Cloudflare Tunnel then puts that on a public HTTPS URL
without port forwarding or touching your router.

Expect the picture to run **6–10 seconds behind real time**. That's inherent to HLS and
is the price of "works in every browser with no plugin."

## Setup

**1. Point it at your camera.** Copy `.env.example` to `.env` and set `RTSP_URL` to the
exact URL you paste into VLC:

```bash
cp .env.example .env
```

If you don't know your camera's RTSP URL, open VLC → Media → Open Network Stream; the
URL you last used is in the dropdown. Otherwise search "<your camera model> RTSP URL".

If your password contains special characters, URL-encode them: `@` → `%40`, `:` → `%3A`,
`/` → `%2F`, `#` → `%23`.

**2. Verify the camera is reachable** before involving a browser:

```bash
npm install
npm run probe
```

This prints the video codec and resolution, or tells you exactly what failed. Get this
passing first — every other problem is easier to diagnose once it does.

**3. Watch locally:**

```bash
npm start
```

Open <http://localhost:8080>. You should see the feed.

**4. Go public.** In a *second* terminal, leaving `npm start` running:

```bash
npm run tunnel
```

Cloudflare prints a URL like `https://random-words-here.trycloudflare.com`. That URL
works from anywhere — send it to anyone, open it on your phone over cellular. It stays
alive as long as both terminals are running.

## Password protection

The quick tunnel URL is unguessable but public: anyone who has it can watch. If you're
going to share it, set a password in `.env`:

```
VIEW_PASSWORD=something-hard-to-guess
```

Viewers get a password prompt before the feed loads.

## A permanent URL

`npm run tunnel` gives a new random URL every restart. For a stable one on your own
domain, use a named tunnel (needs a free Cloudflare account and a domain on Cloudflare):

```bash
cloudflared tunnel login
cloudflared tunnel create camera
cloudflared tunnel route dns camera camera.yourdomain.com
cloudflared tunnel run --url http://localhost:8080 camera
```

Now `https://camera.yourdomain.com` always points at the feed.

## Troubleshooting

**"No signal" in the browser** — run `npm run probe`. If that fails, the problem is the
camera or the network, not this app. Check the URL works in VLC *right now*, and that
this machine is on the same network as the camera.

**Black screen, but the status dot says Live** — your camera is probably sending
H.265/HEVC, which browsers can't decode. `npm run probe` will say so. Fix: set
`VIDEO_MODE=transcode` in `.env` and restart. This re-encodes to H.264, which costs CPU
but works everywhere.

**Stream stutters or drops** — set `RTSP_TRANSPORT=udp` in `.env`. TCP is the default
because it's more reliable, but some cameras behave better over UDP.

**`ffmpeg not found`** — install it and open a *new* terminal so PATH refreshes:
`winget install Gyan.FFmpeg`

## Notes

- FFmpeg only runs while someone is watching; it shuts down 60s after the last viewer
  leaves, so an idle setup isn't constantly pulling from the camera.
- With `VIDEO_MODE=copy` (the default) there's no re-encoding, so CPU use is negligible.
- `.env` is gitignored — your camera password never gets committed.
- This machine must stay on and connected for the stream to work. It's the source.
