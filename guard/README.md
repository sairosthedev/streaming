# Package Guard

Watches the camera feed for the classic porch-piracy sequence:

> a package **appears**, sits there a while, then **disappears** — and nobody
> the system recognises was around when it went.

When that happens it sounds a siren, saves a video clip and snapshot, and logs
the event on a dashboard. A package you collect yourself is fine: it sees your
face and marks it *collected*, not stolen.

It reads the same stream your `titancctv` server already serves, so the camera
is only pulled once.

## How it decides

A plain state machine (in [detector.py](detector.py)), tuned so a real doorstep
doesn't cry wolf:

1. **Delivered** — a box-shaped object is seen continuously for
   `PACKAGE_SETTLE_SECONDS` (default 15s). The settle timer is what stops a
   passer-by's backpack from arming the alarm.
2. **Gone** — that package is then absent for `PACKAGE_GONE_SECONDS` (default
   5s). The delay is because a person standing in front of the package looks
   identical to the package vanishing, for a second or two.
3. **Theft vs collection** — when it goes, was a known face seen in the last
   `FACE_GRACE_SECONDS` (default 30s)? No → **theft**. Yes → **collected**.

All of these live in [config.py](config.py).

## Setup

```bash
# from the repo root, using the existing venv
.venv/Scripts/python.exe -m pip install -r guard/requirements.txt
```

Register the people who are allowed to take packages — one clear, front-facing
photo each, filename = their name:

```
guard/known_faces/mac.jpg
guard/known_faces/sarah.jpg
```

## Run

The camera server must be running first (it publishes the local RTSP the guard
reads):

```bash
npm run camera            # terminal 1  -- your existing streaming server
.venv/Scripts/python.exe guard/app.py   # terminal 2 -- the guard
```

Then open **http://localhost:8090**.

## Important: the face-recognition dependency

The "known face" rule needs the `face_recognition` library (which needs
`dlib`). If it isn't installed, the guard **still runs and still detects a
package leaving** — but it can't tell you from a thief, so **every** collection
is reported as a theft. The dashboard shows a red banner when this is the case.

On Windows, install the prebuilt wheel (no compiler needed):

```bash
.venv/Scripts/python.exe -m pip install dlib-bin face_recognition
```

## Tuning

- **Phantom packages / false deliveries** — raise `CONFIDENCE`, or narrow
  `PACKAGE_CLASSES`. COCO has no "package" class, so we match box-like classes
  (suitcase, handbag, backpack, book); drop any that misfire in your scene.
- **Missing real thefts** — lower `CONFIDENCE`, or shorten
  `PACKAGE_SETTLE_SECONDS`.
- **Your own pickups flagged as theft** — add more/better photos, or raise
  `FACE_TOLERANCE` slightly (looser matching).
- **CPU too high** — raise `DETECT_EVERY_N_FRAMES` so YOLO runs less often.

## Files

| File | What it is |
|------|------------|
| `detector.py` | Video loop, YOLO + face recognition, the theft state machine |
| `app.py` | Flask dashboard + MJPEG live view |
| `config.py` | Every tunable |
| `templates/index.html` | The dashboard page |
| `known_faces/` | One photo per allowed person; filename is their name |
| `events/` | Saved theft clips and snapshots |
