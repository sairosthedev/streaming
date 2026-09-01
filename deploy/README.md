# Running the camera server on a Raspberry Pi 5

The Pi becomes the always-on box next to the camera. Everything here assumes
Raspberry Pi OS **Bookworm, 64-bit**.

## Check the OS first

`npm run setup` downloads the `linux_arm64v8` MediaMTX build. On a 32-bit OS it
downloads a binary the system cannot execute, and the failure is confusing.

```bash
uname -m                              # must print: aarch64
grep PRETTY_NAME /etc/os-release      # must be Bookworm or newer
cat /proc/device-tree/model           # confirms Pi 5
```

If `uname -m` says `armv7l`, reflash with the 64-bit image. Raspberry Pi Imager
can preset Wi-Fi and enable SSH before writing the card, so no monitor needed.

## The Pi 5 has no hardware H264 encoder

This is the single fact that shapes everything else. The Pi 4 had one; the Pi 5
does not. So `libx264` in `src/webrtc.js` runs on the CPU, and every pixel costs.

This camera **needs** transcoding — it emits full-range `yuvj420p`, which
browsers render as a grey screen (see the comment in `transcodeArgs`). So the
cost cannot simply be avoided by passing the stream through.

Rough budget on a Pi 5, one camera:

| Source | Resolution | CPU |
|---|---|---|
| `subtype=0` (main) | 1920x1080 | ~2-3 of 4 cores |
| `subtype=1` (sub)  | 704x576   | ~1/3 of one core |

Measure it rather than trusting the table — that is what `npm run loadtest` is
for. **11 NVR cameras at 1080p will not fit on one Pi.** Substreams, fewer
cameras, or a second Pi.

## Install

```bash
sudo apt update
sudo apt install -y ffmpeg git nodejs npm

git clone <repo> ~/streaming
cd ~/streaming/pc
npm install
npm run setup            # fetches MediaMTX (~30 MB, arm64)
```

Copy `.env` across from the working machine. It is gitignored, so it will not
arrive with the clone. Then verify the camera before anything else:

```bash
npm run probe
```

A clean probe prints the codec and resolution. If that fails, nothing downstream
can work — fix it there.

```bash
npm start
```

## Measure before scaling

With the server running and a browser actually watching the stream:

```bash
npm run loadtest            # 5 minutes
npm run loadtest -- 720     # 1 hour, for the stability question
```

It samples CPU, SoC temperature and the firmware's throttle flags, then says
which limit you hit. Temperature matters as much as CPU: the Pi 5 drops its
clock around 80C, and a throttled run understates what the box can really do.

If it reports under-voltage, stop — the readings are meaningless until the
power supply is adequate. Use the official 27W USB-C PSU.

## Start on boot

The unit files are templates (`@`), so the `%i` becomes the username. For the
default `pi` user:

```bash
sudo cp ~/streaming/deploy/camera.service        /etc/systemd/system/camera@.service
sudo cp ~/streaming/deploy/camera-tunnel.service /etc/systemd/system/camera-tunnel@.service
sudo systemctl daemon-reload

sudo systemctl enable --now camera@pi
```

Check it, and watch the logs:

```bash
systemctl status camera@pi
journalctl -u camera@pi -f
```

The tunnel is a separate unit, so the camera can run LAN-only if you would
rather not expose it:

```bash
sudo systemctl enable --now camera-tunnel@pi
```

`camera-tunnel` wants `camera` but is not bound to it — the tunnel failing will
not take the camera server down with it.

### One-time cloudflared setup

The tunnel unit assumes the named tunnel already exists. `cloudflared` is not in
the Debian repos; install from Cloudflare's own repo (<https://pkg.cloudflare.com>),
then, once per machine:

```bash
cloudflared tunnel login
cloudflared tunnel create titan-camera
cloudflared tunnel route dns titan-camera camera.titancctv.xyz
```

Credentials land in `~/.cloudflared`, which the unit reads.

## Notes

- **MongoDB Atlas** must be reachable from the Pi's network, and the site's IP
  may need allowlisting in Atlas, or startup hangs on the registry lookup.
- **Cooling**: a sustained software encode will heat the SoC. An active cooler
  is worth having before judging performance.
- The server handles `SIGTERM`, so `systemctl stop` shuts ffmpeg and MediaMTX
  down cleanly rather than orphaning them.
