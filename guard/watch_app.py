"""
Smart entry watch app.

This is the practical "best of" version for the project:

- YOLO person detection on the live camera
- motion trigger to ignore noise
- people counter using a virtual line
- local dashboard with live view and recent alerts

Run:
    python guard/watch_app.py
Then open:
    http://localhost:8092
"""
import json
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# Log module initialization
_logpath = r"c:\Users\macdo\Downloads\streaming\watch_app_worker.log"
try:
    with open(_logpath, "w") as f:
        f.write("[MODULE] watch_app module starting\n")
except:
    pass

import cv2
import numpy as np
from flask import Flask, Response, jsonify, render_template
# YOLO is lazy-loaded in detect_people() to avoid blocking on import

import config

DASHBOARD_PORT = 8092
ALERT_COOLDOWN_SECONDS = 20
FRAME_SAMPLE_EVERY = 8
MOTION_THRESHOLD = 0.012
MAX_TRACK_AGE = 40
LOW_LATENCY_STREAM = True


@dataclass
class AlertEvent:
    kind: str
    at: str
    detail: str


@dataclass
class WatchState:
    connected: bool = False
    motion: bool = False
    people: int = 0
    in_count: int = 0
    out_count: int = 0
    last_alert: str | None = None
    events: list = field(default_factory=list)
    frame: np.ndarray | None = None


state = WatchState()
state_lock = threading.Lock()
model = None  # Lazy-loaded in detect_people()


class Track:
    def __init__(self, center, frame_idx):
        self.center = center
        self.last_seen = frame_idx
        self.last_crossed = None


tracks: dict[int, Track] = {}
next_track_id = 1


def euclidean(a, b):
    return float(np.hypot(a[0] - b[0], a[1] - b[1]))


def matched_centers(detections, current_tracks):
    """Match new detections to old tracks by proximity."""
    assignments = {}
    used = set()

    for det_id, meta in detections.items():
        det_center = meta["center"]
        best_track = None
        best_dist = 999999.0
        for track_id, track in current_tracks.items():
            if track_id in used:
                continue
            dist = euclidean(det_center, track.center)
            if dist < 120 and dist < best_dist:
                best_dist = dist
                best_track = track_id

        if best_track is not None:
            assignments[det_id] = best_track
            used.add(best_track)

    return assignments


def update_people_count(detections, frame_idx):
    """Returns (people_count, in_count, out_count, all_current_tracks)."""
    global tracks, next_track_id

    old_tracks = dict(tracks)
    matched = matched_centers(detections, old_tracks)

    current_tracks = {}
    for det_id, meta in detections.items():
        det_center = meta["center"]
        track_id = matched.get(det_id)
        if track_id is None:
            track_id = next_track_id
            next_track_id += 1
        t = old_tracks.get(track_id, Track(det_center, frame_idx))
        prev_center = t.center
        t.center = det_center
        t.last_seen = frame_idx
        current_tracks[track_id] = t

        # A simple virtual line crossing count.
        line_y = int(state.frame.shape[0] * 0.58)
        if prev_center is not None:
            was_above = prev_center[1] < line_y
            now_above = det_center[1] < line_y
            if was_above != now_above:
                if not was_above and now_above:
                    # down to up => entering
                    state.in_count += 1
                elif was_above and not now_above:
                    # up to down => leaving
                    state.out_count += 1

    # Drop stale tracks.
    for track_id, track in list(old_tracks.items()):
        if track_id not in current_tracks and frame_idx - track.last_seen > MAX_TRACK_AGE:
            continue

    tracks = current_tracks
    return len(current_tracks), state.in_count, state.out_count


def motion_percentage(prev_gray, gray):
    diff = cv2.absdiff(prev_gray, gray)
    _, thresh = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
    return float(np.count_nonzero(thresh)) / thresh.size


def trigger_alert(message):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with state_lock:
        if len(state.events) and state.events[0]["message"] == message:
            return
        state.events.insert(0, {"kind": "alert", "at": now, "message": message})
        state.events = state.events[:8]
        state.last_alert = now


def detect_people(frame):
    global model
    if model is None:
        from ultralytics import YOLO
        print("[watch] loading YOLO model...")
        model = YOLO(config.YOLO_MODEL)
        print("[watch] YOLO model ready")
    
    results = model(frame, verbose=False, conf=0.35)[0]
    people = {}
    for box in results.boxes:
        cls_id = int(box.cls[0]) if hasattr(box.cls, "__len__") else int(box.cls)
        name = model.names.get(cls_id, str(cls_id))
        if name == "person":
            x1, y1, x2, y2 = [int(v) for v in box.xyxy[0]]
            cx = (x1 + x2) / 2
            cy = (y1 + y2) / 2
            people[len(people)] = {
                "center": (cx, cy),
                "box": (x1, y1, x2, y2),
                "conf": float(box.conf[0]) if hasattr(box.conf, "__len__") else float(box.conf),
            }
    return people


def append_annotation(frame, people_count, motion_active, in_count, out_count, detections=None):
    display = frame.copy()
    h, w = display.shape[:2]
    line_y = int(h * 0.58)
    cv2.line(display, (0, line_y), (w, line_y), (0, 255, 255), 2)
    cv2.putText(display, f"people: {people_count}", (20, 35), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
    cv2.putText(display, f"in: {in_count}   out: {out_count}", (20, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 0), 2)
    cv2.putText(display, "motion" if motion_active else "idle", (20, 110), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 200, 255), 2)

    if detections:
        for meta in detections.values():
            x1, y1, x2, y2 = meta["box"]
            conf = meta["conf"]
            cv2.rectangle(display, (x1, y1), (x2, y2), (0, 255, 0), 2)
            label = f"person {conf:.2f}"
            cv2.putText(display, label, (x1, max(20, y1 - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

    return display


def worker():
    logpath = r"c:\Users\macdo\Downloads\streaming\watch_app_worker.log"
    # Write immediately to ensure we catch any errors
    with open(logpath, "w") as f:
        f.write("[worker] thread started\n")
        f.flush()
    
    try:
        with open(logpath, "a") as logfile:
            def log(msg):
                try:
                    logfile.write(msg + "\n")
                    logfile.flush()
                except:
                    pass
            
            log("[worker] imports beginning")
            cap = None
            frame_idx = 0
            fail_count = 0
            log("[worker] variables initialized")

            while True:
                if cap is None or not cap.isOpened():
                    log(f"[worker] opening stream...")
                    cap = cv2.VideoCapture(config.STREAM_URL, cv2.CAP_FFMPEG)
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    if not cap.isOpened():
                        fail_count += 1
                        if fail_count % 10 == 0:
                            log(f"[worker] cannot open stream (attempt {fail_count})")
                        time.sleep(2)
                        continue
                    
                    fail_count = 0
                    log(f"[worker] stream opened successfully")
                    with state_lock:
                        state.connected = False

                try:
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        time.sleep(1 / 30)
                        continue
                    
                    with state_lock:
                        state.connected = True
                        state.frame = frame
                    
                    frame_idx += 1
                    if frame_idx % 30 == 0:
                        log(f"[worker] frame {frame_idx} connected=true")
                
                except Exception as e:
                    log(f"[worker] read exception: {type(e).__name__}: {e}")
                    try:
                        cap.release()
                    except:
                        pass
                    cap = None
                    time.sleep(2)
                    continue

                time.sleep(1 / 30)
    except Exception as e:
        try:
            with open(logpath, "a") as f:
                f.write(f"[worker] EXCEPTION: {type(e).__name__}: {e}\n")
                import traceback
                f.write(traceback.format_exc() + "\n")
        except:
            pass
        raise


app = Flask(__name__, template_folder="templates")


@app.route("/")
def index():
    return render_template("watch.html")


@app.route("/stream")
def stream():
    def generator():
        while True:
            with state_lock:
                frame = state.frame
            if frame is None:
                time.sleep(0.1)
                continue
            ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if ok:
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg.tobytes() + b"\r\n")
            time.sleep(1 / 15)
    return Response(generator(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/api/state")
def api_state():
    with state_lock:
        payload = {
            "connected": state.connected,
            "motion": state.motion,
            "people": state.people,
            "in_count": state.in_count,
            "out_count": state.out_count,
            "last_alert": state.last_alert,
            "events": state.events,
        }
    return jsonify(payload)


if __name__ == "__main__":
    with open(_logpath, "a") as f:
        f.write("[MAIN] Starting worker thread\n")
        f.flush()
    
    threading.Thread(target=worker, daemon=True).start()
    
    with open(_logpath, "a") as f:
        f.write("[MAIN] Worker thread started, launching Flask\n")
        f.flush()
    
    print(f"\n  Smart watch -> http://localhost:{DASHBOARD_PORT}")
    print(f"  Stream source: {config.STREAM_URL}\n")
    app.run(host="0.0.0.0", port=DASHBOARD_PORT, threaded=True)
