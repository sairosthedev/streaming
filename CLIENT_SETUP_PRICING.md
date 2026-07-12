# Streaming Camera Setup and Pricing

This document summarizes the full setup for the camera streaming system and gives realistic budget ranges you can share with a client.

## What the system does

The system takes a camera that already outputs RTSP, converts that stream into browser-friendly HLS, and makes it available in a normal web browser.

### Live path

- Camera -> RTSP
- FFmpeg -> HLS
- Node server or Vercel app -> HTTPS
- Cloudflare Tunnel or public web app -> browser

Browsers do not play RTSP directly, so FFmpeg repackages the camera stream into HLS. The tradeoff is a small delay, typically about 6-10 seconds behind real time.

## Two deployment options

### Option A: Local always-on device + Cloudflare Tunnel

This is the simplest setup.

How it works:

- The camera stays on-site.
- A small computer on the same network runs the server.
- FFmpeg pulls the RTSP feed and writes HLS segments.
- Cloudflare Tunnel publishes the local server to the internet.

Best for:

- Lowest cost
- Simple setup
- No router port forwarding
- No cloud upload workflow

### Option B: Camera-side agent + Vercel-hosted viewer

This version is useful when you want the viewer app hosted in the cloud.

How it works:

- A machine on the camera network runs the agent.
- The agent pulls RTSP and uploads live HLS segments to Vercel Blob.
- The Vercel app serves the viewer and proxies the live segments.

Best for:

- Hosting the viewing app in the cloud
- Not depending on a local tunnel for viewer access
- Cleaner access from anywhere, while still keeping the camera on-site

## Hardware needed

### Required

- IP camera with RTSP support
- Always-on device on the same network as the camera
- Power supply for that device
- Internet connection

### Recommended always-on device choices

#### 1. Raspberry Pi 5

Estimated one-time cost:

- Raspberry Pi 5: $80-$120
- Power supply: $10-$15
- Case and cooling: $10-$25
- microSD card: $10-$25
- Optional SSD setup: $40-$80 extra

Estimated total:

- Basic setup: $110-$185
- More reliable SSD setup: $150-$265

Good for:

- H.264 passthrough
- Low-power always-on use
- Small, budget-friendly installs

Limitations:

- Less comfortable if transcoding is needed
- microSD is less durable than SSD for 24/7 use

#### 2. Intel N100 mini PC

Estimated one-time cost:

- Mini PC: $150-$300
- Optional SSD upgrade if needed: usually included, otherwise $30-$80

Estimated total:

- $150-$300

Good for:

- The best balance of cost and reliability
- Better headroom for FFmpeg
- Safer choice if the camera may need transcoding

This is usually the best recommendation if the client wants something dependable and low-maintenance.

#### 3. Used small PC or thin client

Estimated one-time cost:

- $50-$200 used

Good for:

- Lowest hardware cost if one is already available
- Basic always-on streaming duties

Tradeoffs:

- Higher power draw than a Pi or mini PC in some cases
- Quality and reliability depend on the specific machine

#### 4. UPS battery backup, optional

Estimated cost:

- $60-$150

Why it matters:

- Keeps the stream online during short power interruptions
- Protects the device from unexpected shutdowns

## Software and recurring costs

### Local tunnel setup

- Cloudflare quick tunnel: $0
- Cloudflare account: $0
- Custom domain for a stable public URL: usually $10-$20 per year
- Named Cloudflare tunnel: $0 extra beyond the domain

### Cloud-hosted viewer setup

- Vercel app: plan-dependent
- Vercel Blob storage and bandwidth: usage-dependent
- Agent software: no license fee

For a client quote, it is safest to treat the cloud-hosting cost as variable and tied to usage, plan choice, and bandwidth.

### Other recurring costs

- Electricity for the always-on device
- Internet service at the camera site
- Domain renewal, if a custom URL is wanted

## Budget ranges

### Lowest-cost working setup

- Raspberry Pi 5 bundle
- microSD card
- Cloudflare quick tunnel

Estimated total: $110-$185

### Recommended reliable setup

- Intel N100 mini PC
- Cloudflare quick tunnel or named tunnel
- Optional SSD included in the mini PC

Estimated total: $150-$300

### More robust setup

- Intel N100 mini PC
- SSD-based storage
- UPS battery backup
- Custom domain
- Named Cloudflare tunnel

Estimated total: $220-$450

## What the client needs to provide

- Camera RTSP URL
- Camera username and password, if required
- A place to keep the always-on device near the camera
- Network access to the camera
- If using a custom public URL, a domain name

## Setup steps

### Local tunnel version

1. Copy the environment file and set the camera RTSP URL.
2. Install dependencies.
3. Verify the camera feed with the probe command.
4. Start the local server.
5. Start the tunnel.
6. Open the public URL.

### Cloud-hosted version

1. Set up the Vercel project.
2. Add the Blob token to the agent environment.
3. Point the agent at the camera RTSP URL.
4. Start the agent on the always-on device.
5. Open the Vercel app.

## Operational notes

- The live feed usually lags the camera by 6-10 seconds.
- The system is designed for browser playback, not ultra-low-latency viewing.
- If the camera outputs H.265/HEVC, transcoding may be required.
- The camera-side machine must stay on for the feed to remain available.
- Password protection can be enabled for shared links.

## Recommended client summary

If the client wants the simplest and most affordable setup, the best recommendation is:

- one small always-on device on-site
- Cloudflare Tunnel for public access
- optional password protection
- optional UPS if uptime matters

If the client wants a stronger all-around option, recommend an Intel N100 mini PC instead of a Raspberry Pi.
