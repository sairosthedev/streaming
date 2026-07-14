"""
Package theft detector -- settings.

Everything you are likely to tune lives here. The .env at the repo root supplies
the camera URL, so the detector follows the camera registry rather than keeping
its own copy of the RTSP password.
"""
import os
from pathlib import Path

ROOT = Path(__file__).parent
KNOWN_FACES_DIR = ROOT / "known_faces"
EVENTS_DIR = ROOT / "events"

# ---------------------------------------------------------------------------
# Video source
#
# Pull from MediaMTX's local RTSP rather than the camera directly: the camera
# only tolerates a couple of connections, and the streaming server is already
# holding one. This also means we read the transcoded, browser-safe stream.
#
# Falls back to the camera's own RTSP URL when the streaming server isn't up.
# ---------------------------------------------------------------------------
CAMERA_NAME = os.getenv("GUARD_CAMERA", "video1")
STREAM_URL = os.getenv("GUARD_STREAM_URL", f"rtsp://127.0.0.1:8554/{CAMERA_NAME}")

# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

# YOLOv8n: the smallest model. Downloads itself (~6MB) on first run. Bigger
# models are more accurate but this runs on every frame, so speed wins.
YOLO_MODEL = "yolov8n.pt"

# COCO has no "package" class, so we take the box-shaped classes it does have.
# A cardboard box on a doorstep reliably reads as one of these.
PACKAGE_CLASSES = {"suitcase", "handbag", "backpack", "book"}
PERSON_CLASS = "person"

# Below this, a detection is noise. Raise it if you get phantom packages.
CONFIDENCE = 0.35

# Don't run YOLO on all 25 fps -- nothing on a doorstep changes that fast, and
# it would peg a CPU for no benefit.
DETECT_EVERY_N_FRAMES = 10

# ---------------------------------------------------------------------------
# The theft rule
#
#   package appears -> stays put -> vanishes -> was a known face around?
#                                                  no  -> THEFT
#                                                  yes -> collected, fine
# ---------------------------------------------------------------------------

# A package must be seen for this long before we consider it "delivered". Stops
# a pedestrian's backpack passing through frame from arming the alarm.
PACKAGE_SETTLE_SECONDS = 15

# ...and be gone for this long before we call it "taken". A person walking in
# front of the package briefly hides it; that is not a theft.
PACKAGE_GONE_SECONDS = 5

# How far back to look for a known face when a package vanishes. Someone
# collecting their own parcel was on camera in the seconds before it went.
FACE_GRACE_SECONDS = 30

# Face match strictness. Lower = stricter. 0.6 is the library's default;
# 0.5 cuts false "that's you" matches at the cost of more misses.
FACE_TOLERANCE = 0.5

# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------
SIREN_ENABLED = True
SIREN_SECONDS = 5

# Seconds of video to keep around a theft. We hold a rolling buffer, so the clip
# starts BEFORE the alarm -- otherwise the evidence begins after the thief left.
CLIP_PRE_SECONDS = 15
CLIP_POST_SECONDS = 10

# Don't re-alarm on the same event.
ALERT_COOLDOWN_SECONDS = 60

DASHBOARD_PORT = int(os.getenv("GUARD_PORT", "8090"))
