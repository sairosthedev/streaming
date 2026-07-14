"""
Dashboard: live view, current state, and what has happened.

  python guard/app.py     -> http://localhost:8090

The detector runs on a background thread; this only reads its state.
"""
import threading
import time

import cv2
from flask import Flask, Response, jsonify, render_template, send_from_directory

import config
from detector import Detector, FACES_AVAILABLE

app = Flask(__name__)
detector = Detector()


def mjpeg():
    """The live view. MJPEG, not WebRTC: this is a local debug view, and a
    <img src> that just works beats a signalling handshake here."""
    while True:
        with detector.lock:
            frame = detector.state.frame
        if frame is None:
            time.sleep(0.1)
            continue

        # Downscale: 1080p JPEGs at 15fps saturate the browser for no gain.
        small = cv2.resize(frame, (960, 540))
        ok, jpg = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
                   + jpg.tobytes() + b"\r\n")
        time.sleep(1 / 15)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/stream")
def stream():
    return Response(mjpeg(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/api/state")
def state():
    s = detector.state
    return jsonify({
        "status": s.status,
        "connected": s.connected,
        "package_present": s.package_present,
        "people_in_frame": s.people_in_frame,
        "known_face": s.known_face_name,
        "faces_available": FACES_AVAILABLE,
        "known_names": detector.known_names,
        "events": [e.as_dict() for e in s.events],
    })


@app.route("/events/<path:name>")
def event_file(name):
    return send_from_directory(config.EVENTS_DIR, name)


if __name__ == "__main__":
    threading.Thread(target=detector.run, daemon=True).start()
    print(f"\n  Package guard -> http://localhost:{config.DASHBOARD_PORT}")
    print(f"  Watching:        {config.STREAM_URL}\n")
    app.run(host="0.0.0.0", port=config.DASHBOARD_PORT, threaded=True)
