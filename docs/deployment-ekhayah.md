# eKHAYAH — 92-camera deployment (tangible spec)

**Goal:** live-stream + AI-detect 92 cameras (3 NVRs) locally, and expose them
online via tunnel. Replaces the Raspberry Pi, which cannot scale.

---

## The realization that makes this affordable

You do NOT integrate 92 cameras. You integrate **3 NVRs**, which already
aggregate and record every camera. Your server pulls a handful of RTSP feeds
from each NVR — not 92 separate devices.

| NVR | IP | Model | Channels |
|-----|-----|-------|----------|
| NVR-1 | 192.168.89.246 | DS-7632NXI-K2/16P | 32 |
| NVR-2 | 192.168.89.2   | DS-8664NI-I8      | 64 |
| NVR-3 | 192.168.89.250 | DS-7632NXI-K2/16P | 32 |

Not every channel has a live camera — NVR-1 had 13 of 32 populated. Real live
count across all three is likely **~60-92**, not a fixed 92.

---

## Why the Pi failed, and what changes on a server

The single line that matters, in `pc/src/webrtc.js`:

```
'-c:v', 'libx264',      # SOFTWARE H.264 encode — runs on CPU
'-preset', 'ultrafast', # already the fastest/lowest-quality preset
```

- On the **Pi 5** (no hardware encoder) this ran on the CPU: ~1.4 cores per
  H.265 stream, 82 °C on ONE camera.
- On a machine with an **NVIDIA GPU**, this line becomes `h264_nvenc` /
  `hevc_nvenc` — encoding moves to the GPU's dedicated **NVENC** chip, and
  H.265 **decode** moves to **NVDEC**. The CPU barely participates.

A single mid-range NVIDIA GPU does **30-40 simultaneous transcodes**. That is
the whole ballgame.

### Another lever already in your favour

Many plant cameras stream **H.264**, not H.265 (NVR-1: 7 of 13 were H.264).
H.264 needs **no transcode at all** — it passes straight through (`-c:v copy`,
near-zero cost). Only the H.265 cameras need the GPU. So the true transcode load
is well under 92.

---

## The hardware — one server (recommended)

| Component | Spec | Why |
|-----------|------|-----|
| **GPU** | 1× NVIDIA **RTX 4000 Ada** (20GB) or **RTX 4070/4080**, or used **RTX 3060 12GB** on a budget | NVENC/NVDEC. Newer NVENC lifts the old 3-8 stream driver cap; one card handles all H.265 here. |
| **CPU** | 8-core (Ryzen 7 / i7) | Runs MediaMTX, the app, YOLO orchestration. |
| **RAM** | 32 GB | Comfortable for the stack + inference. |
| **Storage** | 500 GB SSD (OS/app only) | **The NVRs already record** — this server does live + AI, not archival. |
| **NIC** | Gigabit (2× if separating camera LAN from internet) | Camera traffic ~185 Mbps substream aggregate. |
| **OS** | Ubuntu 22.04 LTS + NVIDIA drivers + CUDA | Best ffmpeg NVENC support; runs the stack as systemd services. |

**Rough cost:** a single RTX-class GPU workstation is one box, not the 15+ Pis
the naive approach implied. Budget tier (RTX 3060) is achievable; production
(RTX 4000 Ada) is the safe choice for headroom + AI.

### When to add a second server
If you run **YOLO on every camera at once** (not just streaming), inference
competes with transcode for the GPU. At that point split: one box streams, one
runs detection — or add a second GPU. Start with one; measure; scale.

---

## Software changes needed (small)

Your stack already works. To make it GPU-native:

1. **NVENC transcode** — swap `libx264` for `hevc_nvenc`/`h264_nvenc` in
   `pc/src/webrtc.js`, gated by a `USE_NVENC` env flag so the same code still
   runs on CPU elsewhere. ~10 lines.
2. **NVDEC decode** — add `-hwaccel cuda` to the ffmpeg input for H.265 sources.
3. **YOLO on GPU** — confirm ultralytics uses CUDA (`device=0`), not CPU. One
   line; 10-50× faster inference.
4. **systemd services** — server + tunnel auto-start on boot (the unit files in
   `deploy/` already exist; adapt paths).

None of this is a rewrite. It is the same pipeline with the encode/decode/infer
steps pointed at the GPU.

---

## Network & deployment

1. **Server lives at the plant**, on the camera network (`192.168.89.x`) — the
   1.2 Gbps of camera traffic cannot go over the internet, so compute must be
   local. Give it a static IP (e.g. `192.168.89.10`).
2. **Static route or second NIC** for internet (tunnel + MongoDB Atlas), so
   cameras come over one interface and internet over another — avoids the
   Wi-Fi/Ethernet routing fight we hit on the laptop.
3. **Tunnel** (`cloudflared`, already configured: `camera.titancctv.xyz`) runs
   as a service → online viewing from anywhere, no port-forwarding.
4. **NVR credentials** — still need NVR-2 (`.2`) and NVR-3 (`.250`) passwords.
   NVR-1 works with `admin` / `<NVR-1 password — see private runbook>`. Get the *device* passwords (not iVMS
   logins) from the site.

---

## Phased plan

| Phase | What | Outcome |
|-------|------|---------|
| **1. Now** | Laptop + NVR-1 (13 cams), local + tunnel | Proves the full pipeline online today |
| **2. Creds** | Get NVR-2 / NVR-3 passwords, register all live channels | Full camera inventory in MongoDB |
| **3. Server** | Procure GPU box, install Ubuntu+CUDA, deploy stack with NVENC | All ~60-92 cameras, GPU-accelerated |
| **4. AI** | YOLO plant rules (intrusion, PPE, vehicle/zone) on GPU | Detection at scale |

Phase 1 is doable this week on the laptop. Phase 3 is the real, permanent
solution — one GPU server, not a wall of Pis.

---

## One-line summary for the client

> The camera system runs on 3 NVRs aggregating ~92 cameras. Streaming and AI
> require GPU-accelerated video (H.265 decode + H.264 encode + YOLO), so the
> platform is **one NVIDIA GPU server** on-site, connected to the 3 NVRs and
> exposed online through a secure tunnel — the same software already proven,
> moved from a single-camera Pi to a server that does the whole plant.
