# eKHAYAH — full Ubuntu server setup (CPU-based)

Turn the new desktop into the permanent, always-on streaming server: cameras in,
local viewing, online tunnel, AI detection, auto-start on boot. Follow top to
bottom. Commands run ON the Ubuntu machine unless noted.

Login user assumed to be `titan`. Substitute your actual username throughout.

---

## Phase 0 — Facts you need on hand

| Thing | Value |
|-------|-------|
| NVR-1 | 192.168.89.246 — `admin` / `<NVR-1 password — see private runbook>` ✅ |
| NVR-2 | 192.168.89.2  — password ⬜ NEEDED (device password, not iVMS) |
| NVR-3 | 192.168.89.250 — password ⬜ NEEDED (a previously-tried password was wrong — see private runbook) |
| Camera network | 192.168.89.0/24, no DHCP → static IP required |
| Server static IP | 192.168.89.10 (pick a free one; .202 was the laptop) |
| MongoDB / tunnel / view password | in the repo `.env` (copy it across) |

**CPU reality:** H.264 cameras pass through at ~zero cost (many at once). H.265
cameras transcode in software — a modern multi-core CPU does maybe 8-20 before
saturating. Test with the load script (Phase 6) and enable within budget.

---

## Phase 1 — Install Ubuntu + base tools

After Ubuntu 22.04 is installed:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git ffmpeg curl build-essential

# Node 20 (repo needs >=18; 20 is current LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # expect v20.x
ffmpeg -version | head -1
```

---

## Phase 2 — Get the code + secrets

```bash
git clone https://github.com/sairosthedev/streaming ~/streaming
cd ~/streaming/pc
npm install
npm run setup     # fetches MediaMTX (auto-detects linux_amd64)
```

Copy `.env` from the laptop to `~/streaming/.env` (repo ROOT, not pc/). It is
gitignored so it will NOT arrive with the clone. From the laptop:

```bash
scp .env titan@192.168.89.10:~/streaming/.env
```

---

## Phase 3 — Get onto the camera network

The camera switch has NO DHCP. Set a static IP on the wired interface.

```bash
# find the interface name (e.g. enp3s0)
ip link

# Netplan config (replace enp3s0 with yours)
sudo tee /etc/netplan/01-cameras.yaml >/dev/null <<'YAML'
network:
  version: 2
  ethernets:
    enp3s0:
      addresses: [192.168.89.10/24]
      routes:
        - to: 192.168.89.0/24
          scope: link
YAML
sudo netplan apply

# Verify you can reach a camera and NVR-1
ping -c2 192.168.89.246
```

> **Internet too:** if cameras are on this wired NIC and there's no gateway to
> the internet here, add a SECOND connection (Wi-Fi or a second NIC) WITH a
> default gateway for MongoDB Atlas + the tunnel. Cameras over one interface,
> internet over the other — this avoids the routing fight we hit on the laptop.
> If the camera LAN also has internet, add `gateway4: 192.168.89.1` + nameservers.

---

## Phase 4 — Prove one NVR streams

```bash
cd ~/streaming/pc

# NVR-1 already works. Confirm a channel pulls video (# in pw = %23):
ffprobe -v error -rtsp_transport tcp -select_streams v:0 \
  -show_entries stream=codec_name,width,height -of default=noprint_wrappers=1 \
  -i "rtsp://admin:<PASSWORD>@192.168.89.246:554/Streaming/Channels/302"
# expect: codec_name=h264 ...

# The 13 NVR-1 cameras are already in MongoDB. Start the server:
npm start
```

Open `http://192.168.89.10:8080` from any machine on the network.
Password: the VIEW_PASSWORD from `.env`.

---

## Phase 5 — Add NVR-2 and NVR-3 (when you have passwords)

The scanner finds live channels and registers them. Substreams (N02), MAC-tagged
for auto-discovery. `# / @` etc. in passwords are handled by the scanner.

```bash
cd ~/streaming/pc

# NVR-2 (64ch) — replace PASSWORD
npm run scan -- --user admin --pass 'PASSWORD' --channels 64 --add

# NVR-3 (32ch) — replace PASSWORD
npm run scan -- --user admin --pass 'PASSWORD' --channels 32 --add

# Review what got added
node src/cameras.js list
```

> The scanner probes every channel, registers only the LIVE ones, marks H.264 as
> passthrough and H.265 as transcode automatically. Not every channel has a
> camera — expect fewer than 64/32.

---

## Phase 6 — Measure CPU capacity BEFORE enabling everything

Do not blindly enable 90 cameras — the H.265 transcodes will saturate the CPU.

```bash
cd ~/streaming/pc
# With the server running and something viewing, in another terminal:
npm run loadtest        # samples CPU/temp, tells you the ceiling
```

Enable H.264 cameras freely (near-zero cost). Enable H.265 cameras up to the
number the loadtest shows is sustainable. Disable the rest:

```bash
node src/cameras.js disable <name>    # trim H.265 beyond budget
node src/cameras.js enable  <name>
```

---

## Phase 7 — Run as services (auto-start, no terminal)

The unit files exist in `deploy/`. They are templates (`@username`).

```bash
sudo cp ~/streaming/deploy/camera.service        /etc/systemd/system/camera@.service
sudo cp ~/streaming/deploy/camera-tunnel.service /etc/systemd/system/camera-tunnel@.service
sudo systemctl daemon-reload

# Start + enable the streaming server (replace 'titan' with your user)
sudo systemctl enable --now camera@titan
systemctl status camera@titan
journalctl -u camera@titan -f     # watch it come up
```

Now it starts on every boot, restarts if it crashes, needs no terminal.

---

## Phase 8 — Tunnel online

`cloudflared` needs installing on Linux (not in default apt):

```bash
# Cloudflare's repo
sudo mkdir -p /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared jammy main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

# Copy the tunnel credentials from the laptop
#   from laptop:  scp -r ~/.cloudflared titan@192.168.89.10:~/
cloudflared tunnel list        # should show 'titan-camera'

# Start + enable the tunnel service
sudo systemctl enable --now camera-tunnel@titan
journalctl -u camera-tunnel@titan -f
```

Live online at **https://camera.titancctv.xyz** — password = VIEW_PASSWORD.

---

## Phase 9 — AI detection (optional, when streaming is stable)

```bash
cd ~/streaming
python3 -m venv .venv
.venv/bin/pip install -r guard/requirements.txt

# Plant-safety test on a live camera (intrusion/person/vehicle counting)
.venv/bin/python guard/plant_watch.py --cam nvr1cam3 --seconds 60
```

On CPU, YOLO runs but slowly — run it on a FEW cameras, not all 92. Full-scale
AI is the reason a GPU (RTX A2000 / 3060) is the eventual upgrade. Streaming
works great CPU-only; AI-on-everything is what wants the GPU.

---

## Daily operation

| Task | Command |
|------|---------|
| Restart after camera changes | `sudo systemctl restart camera@titan` |
| See logs | `journalctl -u camera@titan -f` |
| Add/adjust cameras | `node src/cameras.js ...` then restart |
| Check it's running | `systemctl status camera@titan camera-tunnel@titan` |

## The honest capacity summary

- **H.264 cameras:** stream all of them, CPU cost ~zero.
- **H.265 cameras:** transcode-limited — enable what the loadtest sustains (~8-20).
- **All 92 H.265 at once + AI:** wants an NVIDIA GPU. Add an RTX A2000/3060 later;
  same software, just point NVENC at it (`hevc_nvenc`). No rewrite.

This CPU server is a real, permanent, showable solution today. The GPU is a drop-in
capacity multiplier when you need the full plant transcoded + AI on everything.
