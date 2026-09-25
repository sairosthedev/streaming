# Streaming infrastructure — why not a Raspberry Pi, and what to use

**Site:** ~92 cameras across 3 NVRs (Hikvision, H.265).
**Question:** can a Raspberry Pi run the live-streaming + AI detection system?
**Answer:** No. Here is the technical reasoning and the correct hardware.

---

## Why a Raspberry Pi cannot do this job

### 1. The cameras are H.265; browsers cannot play H.265

Every camera here streams **H.265 (HEVC)**. Web browsers cannot decode H.265, so
each stream must be **transcoded to H.264** before it can be viewed in a browser.
Transcoding is CPU-intensive — it is the single most expensive operation in the
whole pipeline.

### 2. The Pi 5 has no hardware video encoder

The Raspberry Pi 4 had a hardware H.264 encoder. **The Pi 5 removed it.** So on a
Pi 5 every transcode runs in **software (libx264) on the CPU** — there is no
hardware path to offload to.

### 3. Measured result: one camera nearly maxed the Pi

Tested on real hardware with this exact system:

| Load | CPU | Temperature | Result |
|------|-----|-------------|--------|
| 1 camera, H.264, transcoded | ~140% (1.4 cores) | **82 °C** | Thermal throttling |

One camera pushed a 4-core Pi 5 to its thermal limit. H.265 (this site) is
**heavier to decode** than the H.264 used in that test.

### 4. The arithmetic for 92 cameras

- Realistic Pi 5 ceiling: **~4–8 transcoded substreams** before it saturates.
- 92 cameras ÷ 6 per Pi ≈ **~15 Raspberry Pis** — and that is only the *video
  relay*, before any AI detection.
- Add YOLO object detection (the package/theft/person detection in this project)
  and the per-device capacity drops further.

Fifteen-plus Raspberry Pis is not an architecture — it is fifteen power supplies,
fifteen SD cards, and fifteen points of failure doing what one proper server does.

### 5. Bandwidth and storage are also past Pi scale

- 92 cameras × ~2 Mbps (substream) ≈ **185 Mbps** continuous just to move video;
  full-resolution main streams push into **multiple Gbps**.
- Continuous recording of 92 cameras is **hundreds of terabytes per month** —
  a storage array, not an SD card.

**Conclusion:** the Pi is the wrong tool by one to two orders of magnitude. It is
excellent for 1–4 cameras at a small site; it is not an enterprise video engine.

---

## What to use instead

### The recommended architecture: GPU server(s) + edge

```
  Cameras ──► NVRs (already installed) ──► GPU server(s) ──► Viewers
             (aggregate + record)          (transcode + AI)   (browser / app)
```

**Key insight:** you do not connect to 92 cameras. You connect to the **3 NVRs**,
which already aggregate and record them. The streaming system pulls a handful of
NVR RTSP feeds, not 92 individual cameras.

### Hardware

| Component | Spec | Why |
|-----------|------|-----|
| **GPU server** | 1–3 servers, each with an **NVIDIA GPU** (RTX 4000-class or better) | NVIDIA GPUs have **NVENC/NVDEC** — dedicated hardware for H.265 decode and H.264 encode. One GPU transcodes dozens of streams the CPU never touches. |
| **CPU / RAM** | 8+ cores, 32–64 GB | Runs MediaMTX, the app, and the YOLO inference pipeline. |
| **Network** | Gigabit minimum; 10 GbE backbone for full-res | To carry aggregate camera bandwidth without loss. |
| **Storage** | Handled by the existing NVRs | The NVRs already record; the streaming server only relays live + runs AI. |

### Why a GPU changes everything

- **H.265 decode** → NVDEC (hardware), not the CPU.
- **H.264 encode** → NVENC (hardware), not libx264.
- A single mid-range NVIDIA GPU handles **~30–40 simultaneous transcodes**;
  a Pi 5 handles ~4–8 in slow software. That is roughly a **5–10× per-box gain**,
  before counting the AI acceleration the GPU also provides.
- YOLO runs on the same GPU at **hundreds of inferences/sec** vs. single digits
  on a Pi CPU.

### Sizing this site

- **Live streaming + AI on all 92 cameras:** 2–3 GPU servers, cameras sharded
  across them (roughly one server per NVR).
- **Live viewing of a subset (wall display, spot-checks):** a single GPU server
  comfortably covers 30–40 streams.

### Optional edge pattern (for multi-site growth)

For a chain of sites, put a **small GPU box per site** (e.g. NVIDIA Jetson Orin,
or a compact GPU mini-PC) that handles that site's cameras locally and reports
only events/clips to a central server. This distributes the bandwidth so no
single link carries everything — the standard way large deployments scale.

---

## Summary for the client

> The camera system is H.265, which browsers can't play, so every stream must be
> transcoded — a GPU-accelerated task. A Raspberry Pi has no video encoder and
> maxes out at a handful of streams; running 92 would take fifteen-plus Pis and
> still lack the AI horsepower. The correct platform is one to three **servers
> with NVIDIA GPUs**, connected to the three existing NVRs. The GPUs decode
> H.265, encode H.264, and run the AI detection in hardware — the whole site on
> a small rack instead of a wall of Pis.

*The software is ready — it is the same system proven on the Pi. Only the
hardware it runs on changes: from a single-camera device to a GPU server.*
