"""
Door-open detector.

Watches one fixed rectangle -- the door -- and tells you when it opens or
closes. It is deliberately NOT machine learning: a door swinging open changes
almost every pixel in its region (the door face leaves, the dark doorway gap
arrives), so a plain frame-difference inside that box is both reliable and
nearly free on CPU. The cost of that simplicity is that the camera must stay
fixed and the door region must be set correctly (see DOOR_REGION).

  python guard/door.py            -> dashboard at http://localhost:8091
                                     and alerts however config says

Alerts, all optional (see config): phone push via ntfy, PC siren, a saved
snapshot + clip, and the dashboard event log.
"""
import os
import sys
# Silence FFmpeg's per-macroblock decode spam. The Wi-Fi link drops packets, so
# frames arrive corrupted and libav logs a line per broken block -- pages of it.
# The env var alone does not gag libav on every OpenCV build, so we also redirect
# this process's stderr (fd 2, where the C-level decoder writes) to the null
# device. Our own messages use print() -> stdout, so they are unaffected. We
# handle corrupt frames ourselves (see _looks_corrupt).
os.environ["OPENCV_FFMPEG_LOGLEVEL"] = "-8"   # AV_LOG_QUIET
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "loglevel;quiet")

def _silence_ffmpeg_stderr():
    """Redirect OS-level stderr to null so libav's decode errors vanish.
    Kept in a function so it can be skipped with GUARD_DEBUG=1 when diagnosing."""
    if os.getenv("GUARD_DEBUG"):
        return
    try:
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 2)          # fd 2 = stderr, where the h264 spam goes
        sys.stderr = os.fdopen(2, "w")
    except Exception:
        pass                          # never let logging setup break the app

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from urllib import request as urlrequest

import cv2
import numpy as np
from flask import Flask, Response, jsonify, render_template, send_from_directory

import config

# Gag the decoder now that cv2 (and its import-time errors, which we DO want to
# see) is loaded. Set GUARD_DEBUG=1 to keep stderr for troubleshooting.
_silence_ffmpeg_stderr()

# ---------------------------------------------------------------------------
# Door-specific settings. Kept here rather than config.py so the door detector
# is self-contained -- config.py is the package-theft detector's.
# ---------------------------------------------------------------------------

# The rectangle to watch, (x1, y1, x2, y2) in the 1920x1080 frame. This is the
# door in your bedroom camera; re-mark it if you move the camera (run this file
# with --mark, see bottom).
DOOR_REGION = (575, 715, 905, 1080)

# Fraction of the door region's pixels that must change for "the door moved".
# Higher = less sensitive. 0.12 ignores IR flicker and a hand passing the edge,
# but catches the door itself swinging.
OPEN_THRESHOLD = 0.12

# A control region that should NEVER change -- a patch of blank ceiling. When
# the Wi-Fi link corrupts a frame, the damage is smeared across the WHOLE frame,
# so this region spikes at the same time as the door region. If the control is
# also changing a lot, the frame is garbage and we ignore it rather than call it
# a door event. A real door opening leaves the ceiling untouched.
CONTROL_REGION = (850, 150, 1150, 350)      # blank ceiling, top-centre
CONTROL_MAX_CHANGE = 0.06                    # above this, the frame is corrupt

# The state must hold for this long before we believe it -- stops a person
# walking across the doorway from registering as an open-then-close.
CONFIRM_SECONDS = 1.5

# Don't re-alert on the same open within this window.
COOLDOWN_SECONDS = 20

# Phone push. Leave topic blank to disable. ntfy.sh is free and needs no
# account: install the ntfy app, "subscribe" to this exact topic string.
NTFY_TOPIC = "titan-door-a7f3k9"          # anyone who knows this can see alerts
NTFY_SERVER = "https://ntfy.sh"

SIREN_ENABLED = True
CLIP_PRE_SECONDS = 8
CLIP_POST_SECONDS = 6
DASHBOARD_PORT = 8091


@dataclass
class Event:
    kind: str            # 'opened' | 'closed'
    at: datetime
    snapshot: str | None = None
    clip: str | None = None

    def as_dict(self):
        return {"kind": self.kind, "at": self.at.strftime("%Y-%m-%d %H:%M:%S"),
                "snapshot": self.snapshot, "clip": self.clip}


@dataclass
class State:
    status: str = "starting"     # starting | closed | open | no stream
    connected: bool = False
    door_open: bool = False
    change: float = 0.0          # current fraction of the region that differs
    events: list = field(default_factory=list)
    frame: np.ndarray | None = None


class DoorDetector:
    def __init__(self):
        self.state = State()
        self.lock = threading.Lock()
        self.baseline = None          # the "closed door" reference, grayscale
        self.control_baseline = None  # the never-changing ceiling reference
        self.buffer = deque(maxlen=int(CLIP_PRE_SECONDS * 25))
        self.last_alert = 0.0
        # candidate change we're waiting to confirm
        self._pending = None          # (is_open, since_ts)
        config.EVENTS_DIR.mkdir(exist_ok=True)

    # -- measurement ------------------------------------------------------

    @staticmethod
    def _prep(frame, region):
        x1, y1, x2, y2 = region
        g = cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY)
        return cv2.GaussianBlur(g, (21, 21), 0)

    @staticmethod
    def _frac_changed(baseline, gray):
        diff = cv2.absdiff(baseline, gray)
        _, thresh = cv2.threshold(diff, 30, 255, cv2.THRESH_BINARY)
        return float(np.count_nonzero(thresh)) / thresh.size

    def _looks_corrupt(self, frame):
        """True if this frame is a decode-garbled one (Wi-Fi packet loss).

        The tell: the control patch of blank ceiling -- which physically cannot
        change -- has changed a lot. That only happens when the whole frame is
        smeared with decode errors, so the door reading this frame gives is not
        to be trusted.
        """
        ctrl = self._prep(frame, CONTROL_REGION)
        if self.control_baseline is None:
            self.control_baseline = ctrl
            return False
        return self._frac_changed(self.control_baseline, ctrl) > CONTROL_MAX_CHANGE

    def _change_fraction(self, frame):
        """How much of the door region differs from the closed-door baseline."""
        gray = self._prep(frame, DOOR_REGION)
        if self.baseline is None:
            self.baseline = gray
            return 0.0
        return self._frac_changed(self.baseline, gray)

    # -- the open/close decision -----------------------------------------

    def _update(self, now, change):
        s = self.state
        s.change = change
        is_open = change >= OPEN_THRESHOLD

        # Nothing new: door state matches belief, clear any pending flip.
        if is_open == s.door_open:
            self._pending = None
            return

        # A candidate change. Start (or continue) confirming it.
        if self._pending is None or self._pending[0] != is_open:
            self._pending = (is_open, now)
            return

        # Held long enough?
        if now - self._pending[1] < CONFIRM_SECONDS:
            return
        self._pending = None

        s.door_open = is_open
        if is_open:
            s.status = "open"
            self._alert(Event("opened", datetime.now()))
        else:
            s.status = "closed"
            # Re-learn the closed door as the new baseline: lighting drifts
            # (day/night, IR cut-in) and the old reference would slowly rot.
            with self.lock:
                if s.frame is not None:
                    self.baseline = self._prep(s.frame, DOOR_REGION)
            self._record(Event("closed", datetime.now()))

    # -- alerting ---------------------------------------------------------

    def _alert(self, event):
        now = time.time()
        if now - self.last_alert < COOLDOWN_SECONDS:
            self._record(event)
            return
        self.last_alert = now

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        snap = config.EVENTS_DIR / f"door-{stamp}.jpg"
        clip = config.EVENTS_DIR / f"door-{stamp}.mp4"

        with self.lock:
            frames = list(self.buffer)
        if frames:
            cv2.imwrite(str(snap), frames[-1])
        event.snapshot = snap.name
        event.clip = clip.name
        self._record(event)

        threading.Thread(target=self._siren, daemon=True).start()
        threading.Thread(target=self._push, args=(stamp,), daemon=True).start()
        threading.Thread(target=self._write_clip, args=(frames, clip), daemon=True).start()
        print(f"\n  *** DOOR OPENED *** {stamp}\n")

    def _siren(self):
        if not SIREN_ENABLED:
            return
        try:
            import winsound
            for _ in range(3):
                winsound.Beep(1000, 300)
                winsound.Beep(1400, 300)
        except Exception as err:
            print(f"  [door] siren failed: {err}")

    def _push(self, stamp):
        if not NTFY_TOPIC:
            return
        try:
            req = urlrequest.Request(
                f"{NTFY_SERVER}/{NTFY_TOPIC}",
                data=f"Door opened at {stamp}".encode(),
                headers={"Title": "Door opened", "Priority": "high", "Tags": "door,rotating_light"},
            )
            urlrequest.urlopen(req, timeout=10)
        except Exception as err:
            print(f"  [door] phone push failed: {err}")

    def _write_clip(self, pre, path):
        deadline = time.time() + CLIP_POST_SECONDS
        post = []
        while time.time() < deadline:
            with self.lock:
                if self.state.frame is not None:
                    post.append(self.state.frame.copy())
            time.sleep(1 / 15)
        frames = pre + post
        if not frames:
            return
        h, w = frames[0].shape[:2]
        writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 15, (w, h))
        for f in frames:
            writer.write(f)
        writer.release()

    def _record(self, event):
        with self.lock:
            self.state.events.insert(0, event)
            del self.state.events[50:]
        print(f"  [door] {event.kind} at {event.at.strftime('%H:%M:%S')}")

    # -- main loop --------------------------------------------------------

    def run(self):
        while True:
            cap = cv2.VideoCapture(config.STREAM_URL, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                self.state.connected = False
                self.state.status = "no stream"
                print(f"  [door] cannot open {config.STREAM_URL} -- is the "
                      f"camera server running? retry in 5s")
                time.sleep(5)
                continue

            self.state.connected = True
            self.state.status = "closed"
            self.baseline = None          # re-learn on every (re)connect
            self.control_baseline = None
            print(f"  [door] watching door region {DOOR_REGION} on {config.STREAM_URL}")

            frame_no = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    print("  [door] stream dropped -- reconnecting")
                    break
                frame_no += 1
                with self.lock:
                    self.state.frame = frame
                    self.buffer.append(frame.copy())

                # 5x/sec is plenty for a door and keeps CPU near zero.
                if frame_no % 5 == 0:
                    # A decode-corrupted frame (Wi-Fi packet loss) would give a
                    # bogus door reading -- skip it, and don't let the door
                    # baseline drift toward garbage either.
                    if self._looks_corrupt(frame):
                        continue
                    self._update(time.time(), self._change_fraction(frame))

            cap.release()


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
app = Flask(__name__, template_folder="templates")
detector = DoorDetector()


def mjpeg():
    x1, y1, x2, y2 = DOOR_REGION
    while True:
        with detector.lock:
            frame = detector.state.frame
            is_open = detector.state.door_open
        if frame is None:
            time.sleep(0.1)
            continue
        f = frame.copy()
        colour = (0, 0, 255) if is_open else (0, 200, 0)
        cv2.rectangle(f, (x1, y1), (x2, y2), colour, 3)
        cv2.putText(f, "OPEN" if is_open else "closed", (x1, y1 - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, colour, 2)
        f = cv2.resize(f, (960, 540))
        ok, jpg = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg.tobytes() + b"\r\n")
        time.sleep(1 / 15)


@app.route("/")
def index():
    return render_template("door.html", topic=NTFY_TOPIC)


@app.route("/stream")
def stream():
    return Response(mjpeg(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/api/state")
def state():
    s = detector.state
    return jsonify({
        "status": s.status,
        "connected": s.connected,
        "door_open": s.door_open,
        "change": round(s.change, 3),
        "threshold": OPEN_THRESHOLD,
        "ntfy_topic": NTFY_TOPIC,
        "events": [e.as_dict() for e in s.events],
    })


@app.route("/events/<path:name>")
def event_file(name):
    return send_from_directory(config.EVENTS_DIR, name)


if __name__ == "__main__":
    import sys
    if "--mark" in sys.argv:
        # Helper: grab a frame and print the current region drawn on it so you
        # can re-tune DOOR_REGION after moving the camera.
        cap = cv2.VideoCapture(config.STREAM_URL, cv2.CAP_FFMPEG)
        ok, frame = cap.read()
        cap.release()
        if ok:
            x1, y1, x2, y2 = DOOR_REGION
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 4)
            out = config.EVENTS_DIR / "_door_region.jpg"
            cv2.imwrite(str(out), frame)
            print(f"  saved {out} -- open it and adjust DOOR_REGION if the box "
                  f"is not on the door.")
        sys.exit(0)

    threading.Thread(target=detector.run, daemon=True).start()
    print(f"\n  Door watch -> http://localhost:{DASHBOARD_PORT}")
    print(f"  Phone alerts: ntfy topic '{NTFY_TOPIC}' "
          f"({'on' if NTFY_TOPIC else 'off'})")
    print(f"  Watching:     {config.STREAM_URL}\n")
    app.run(host="0.0.0.0", port=DASHBOARD_PORT, threaded=True)
