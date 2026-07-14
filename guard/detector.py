"""
The detector: watch the doorstep, decide when a package has been stolen.

The rule, stated plainly:

    A package appeared, sat there a while, then vanished -- and nobody we
    recognise was around when it went. That is a theft.

Everything here exists to make that sentence reliable in the face of a real
camera: people walk in front of the package, YOLO drops a detection for a frame,
the courier's own backpack wanders through shot. Hence the settle/gone timers and
the rolling face memory, rather than reacting to any single frame.
"""
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

import config

# face_recognition needs dlib, which needs a C++ compiler and often will not
# build on Windows. Without it we can still detect the theft -- we just cannot
# tell the owner from the thief, so every collection looks like one. Degrade
# loudly rather than crashing on import.
try:
    import face_recognition
    FACES_AVAILABLE = True
except ImportError:
    FACES_AVAILABLE = False


@dataclass
class Event:
    kind: str          # 'delivered' | 'collected' | 'THEFT'
    at: datetime
    detail: str
    clip: str | None = None
    snapshot: str | None = None

    def as_dict(self):
        return {
            "kind": self.kind,
            "at": self.at.strftime("%Y-%m-%d %H:%M:%S"),
            "detail": self.detail,
            "clip": self.clip,
            "snapshot": self.snapshot,
        }


@dataclass
class State:
    """What the detector currently believes. The dashboard reads this."""
    status: str = "starting"        # starting | watching | package_present | THEFT
    package_present: bool = False
    package_since: float | None = None
    last_package_seen: float | None = None
    known_face_last_seen: float | None = None
    known_face_name: str | None = None
    people_in_frame: int = 0
    events: list = field(default_factory=list)
    frame: np.ndarray | None = None
    connected: bool = False


class Detector:
    def __init__(self):
        self.state = State()
        self.lock = threading.Lock()
        self.model = YOLO(config.YOLO_MODEL)
        self.known_encodings = []
        self.known_names = []
        self._load_known_faces()

        # Rolling buffer so a theft clip can start BEFORE the alarm fired.
        # Without it the evidence begins the moment the package is already gone.
        self.buffer = deque(maxlen=int(config.CLIP_PRE_SECONDS * 25))
        self.last_alert = 0.0

        config.EVENTS_DIR.mkdir(exist_ok=True)

    # -- known faces ------------------------------------------------------

    def _load_known_faces(self):
        """One jpg/png per person in known_faces/. The filename is their name."""
        if not FACES_AVAILABLE:
            print("  [guard] face_recognition unavailable -- every collection "
                  "will be treated as a theft. See README.")
            return

        for img in config.KNOWN_FACES_DIR.glob("*"):
            if img.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                continue
            encodings = face_recognition.face_encodings(
                face_recognition.load_image_file(img)
            )
            if not encodings:
                print(f"  [guard] no face found in {img.name} -- skipping")
                continue
            self.known_encodings.append(encodings[0])
            self.known_names.append(img.stem)

        if self.known_names:
            print(f"  [guard] known faces: {', '.join(self.known_names)}")
        else:
            print("  [guard] no known faces registered -- ANY collection will "
                  "alarm. Drop a photo in guard/known_faces/ to fix.")

    # -- per-frame analysis -----------------------------------------------

    def _detect(self, frame):
        """Returns (package_seen, n_people, person_boxes)."""
        results = self.model(frame, verbose=False, conf=config.CONFIDENCE)[0]

        package = False
        people = []
        for box in results.boxes:
            name = self.model.names[int(box.cls)]
            if name in config.PACKAGE_CLASSES:
                package = True
            elif name == config.PERSON_CLASS:
                people.append([int(v) for v in box.xyxy[0]])

        return package, len(people), people

    def _known_face_in(self, frame, person_boxes):
        """Name of a recognised person in shot, or None.

        Only searches inside person boxes YOLO already found -- scanning the
        whole 1080p frame for faces is far too slow to do continuously.
        """
        if not FACES_AVAILABLE or not self.known_encodings or not person_boxes:
            return None

        for (x1, y1, x2, y2) in person_boxes:
            # Faces are in the upper part of a person; and pad, since a tight
            # box often clips the head.
            pad = 20
            top = max(0, y1 - pad)
            bottom = min(frame.shape[0], y1 + (y2 - y1) // 2 + pad)
            left = max(0, x1 - pad)
            right = min(frame.shape[1], x2 + pad)

            crop = frame[top:bottom, left:right]
            if crop.size == 0:
                continue

            rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            for enc in face_recognition.face_encodings(rgb):
                hits = face_recognition.compare_faces(
                    self.known_encodings, enc, tolerance=config.FACE_TOLERANCE
                )
                if any(hits):
                    return self.known_names[hits.index(True)]

        return None

    # -- the state machine ------------------------------------------------

    def _update(self, now, package_seen, name_seen, n_people):
        s = self.state
        s.people_in_frame = n_people

        if name_seen:
            s.known_face_last_seen = now
            s.known_face_name = name_seen

        if package_seen:
            s.last_package_seen = now
            if s.package_since is None:
                s.package_since = now

            # Settled long enough to count as a real delivery, not a passer-by.
            if (not s.package_present
                    and now - s.package_since >= config.PACKAGE_SETTLE_SECONDS):
                s.package_present = True
                s.status = "package_present"
                self._record(Event(
                    "delivered", datetime.now(),
                    "Package detected and settled on the doorstep.",
                ))
            return

        # No package in this frame.
        if not s.package_present:
            # Never settled -- something passed through. Forget it.
            if s.package_since and now - s.package_since > config.PACKAGE_SETTLE_SECONDS:
                s.package_since = None
            return

        # A settled package is missing. Give it a moment: a person standing in
        # front of it looks exactly like this for a second or two.
        gone_for = now - (s.last_package_seen or now)
        if gone_for < config.PACKAGE_GONE_SECONDS:
            return

        # It's really gone. Who took it?
        recently = (
            s.known_face_last_seen is not None
            and now - s.known_face_last_seen <= config.FACE_GRACE_SECONDS
        )

        s.package_present = False
        s.package_since = None

        if recently:
            s.status = "watching"
            self._record(Event(
                "collected", datetime.now(),
                f"Package gone -- {s.known_face_name} was present. Not a theft.",
            ))
        else:
            s.status = "THEFT"
            self._alarm()

    # -- alerting ---------------------------------------------------------

    def _alarm(self):
        now = time.time()
        if now - self.last_alert < config.ALERT_COOLDOWN_SECONDS:
            return
        self.last_alert = now

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        snap = config.EVENTS_DIR / f"theft-{stamp}.jpg"
        clip = config.EVENTS_DIR / f"theft-{stamp}.mp4"

        with self.lock:
            frames = list(self.buffer)
        if frames:
            cv2.imwrite(str(snap), frames[-1])

        self._record(Event(
            "THEFT", datetime.now(),
            "Package vanished with no recognised person present.",
            clip=clip.name, snapshot=snap.name,
        ))

        # Both off the hot path: the siren blocks, and the clip keeps recording
        # for CLIP_POST_SECONDS. Neither should stall frame capture.
        threading.Thread(target=self._siren, daemon=True).start()
        threading.Thread(target=self._write_clip, args=(frames, clip), daemon=True).start()

        print(f"\n  *** THEFT DETECTED *** {stamp}  -> {clip.name}\n")

    def _siren(self):
        if not config.SIREN_ENABLED:
            return
        try:
            import winsound
            for _ in range(config.SIREN_SECONDS):
                winsound.Beep(880, 400)
                winsound.Beep(660, 400)
        except Exception as err:
            print(f"  [guard] siren failed: {err}")

    def _write_clip(self, pre_frames, path):
        """Pre-roll from the buffer, then keep recording for a few more seconds."""
        deadline = time.time() + config.CLIP_POST_SECONDS
        post = []
        while time.time() < deadline:
            with self.lock:
                if self.state.frame is not None:
                    post.append(self.state.frame.copy())
            time.sleep(1 / 15)

        frames = pre_frames + post
        if not frames:
            return

        h, w = frames[0].shape[:2]
        writer = cv2.VideoWriter(
            str(path), cv2.VideoWriter_fourcc(*"mp4v"), 15, (w, h)
        )
        for f in frames:
            writer.write(f)
        writer.release()

    def _record(self, event):
        with self.lock:
            self.state.events.insert(0, event)
            del self.state.events[50:]
        print(f"  [guard] {event.kind}: {event.detail}")

    # -- main loop --------------------------------------------------------

    def run(self):
        frame_no = 0
        package_seen = False
        name_seen = None
        n_people = 0

        while True:
            cap = cv2.VideoCapture(config.STREAM_URL, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                self.state.connected = False
                self.state.status = "no stream"
                print(f"  [guard] cannot open {config.STREAM_URL} -- is the "
                      f"camera server running? retrying in 5s")
                time.sleep(5)
                continue

            self.state.connected = True
            self.state.status = "watching"
            print(f"  [guard] watching {config.STREAM_URL}")

            while True:
                ok, frame = cap.read()
                if not ok:
                    print("  [guard] stream dropped -- reconnecting")
                    break

                frame_no += 1
                with self.lock:
                    self.state.frame = frame
                    self.buffer.append(frame.copy())

                # YOLO is the expensive part; the state machine runs on the
                # cached result in between, which is fine -- doorsteps are slow.
                if frame_no % config.DETECT_EVERY_N_FRAMES == 0:
                    package_seen, n_people, boxes = self._detect(frame)
                    name_seen = self._known_face_in(frame, boxes) if boxes else None

                self._update(time.time(), package_seen, name_seen, n_people)

            cap.release()
