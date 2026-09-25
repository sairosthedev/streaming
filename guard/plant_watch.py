"""
Plant safety watch -- a YOLO test that fits an industrial site, not a doorstep.

    python guard/plant_watch.py --cam nvr1cam3
    python guard/plant_watch.py --url "rtsp://user:pass@ip:554/Streaming/Channels/302"

The package detector next door assumes a porch: a box appears and is stolen.
A cement plant has none of that. What a plant actually wants is far simpler and
universal, so it is the honest first test of the YOLO pipeline on this footage:

    * count the people and vehicles in view, every second
    * raise an INTRUSION when a person is seen (optionally only inside a zone)

No known faces, no state machine, no siren wiring -- just "does YOLO see what is
really in this camera?" If this lights up correctly on a live plant feed, the
detection core is proven and the plant-specific rules (PPE, restricted areas,
loading-bay dwell time) are refinements on top, not a rewrite.
"""
import argparse
import os
import sys
import time
from collections import Counter

# Reuse the server's stream + key convention so we pull the same feed once.
STREAM_KEY = os.getenv("STREAM_KEY", "wxbtr5kig0uyf2pzvnq68e9js7mc1adhl3o4")

# COCO classes that matter on an industrial site. YOLOv8n knows these out of the
# box; PPE (helmet/vest) needs a custom-trained model and is a later step.
PLANT_CLASSES = {
    "person": "person",
    "truck": "vehicle",
    "car": "vehicle",
    "bus": "vehicle",
    "forklift": "vehicle",  # not in COCO, but harmless to list
}


def parse_args():
    p = argparse.ArgumentParser(description="YOLO plant-safety watch")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--cam", help="camera name served by the local server, e.g. nvr1cam3")
    src.add_argument("--url", help="a full RTSP/HTTP stream URL")
    p.add_argument("--conf", type=float, default=0.35, help="detection confidence 0-1")
    p.add_argument("--every", type=int, default=10, help="run YOLO every Nth frame")
    p.add_argument("--seconds", type=int, default=60, help="how long to watch (0 = forever)")
    p.add_argument("--zone", action="store_true",
                   help="only alert for people in the middle 50%% of frame (a crude restricted zone)")
    return p.parse_args()


def resolve_source(args):
    if args.url:
        return args.url
    cam = args.cam or "nvr1cam3"
    port = os.getenv("GUARD_PORT_SRC", "8080")
    return f"http://localhost:{port}/{cam}.mp4?key={STREAM_KEY}"


def main():
    args = parse_args()
    source = resolve_source(args)

    try:
        import cv2
        from ultralytics import YOLO
    except ImportError as e:
        print(f"  Missing dependency: {e}. Install with:")
        print("    .venv/Scripts/python.exe -m pip install -r guard/requirements.txt")
        sys.exit(1)

    print(f"\n  Loading YOLOv8n...")
    model = YOLO("guard/yolov8n.pt")

    print(f"  Opening {source.split('?')[0]} ...")
    cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        print("\n  Could not open the stream. Is the server running (npm start),")
        print("  and is --cam a camera it actually serves? Or pass --url directly.\n")
        sys.exit(1)

    print(f"  Watching for {args.seconds or 'unlimited'}s. Ctrl-C to stop.\n")
    print("  time     people  vehicles  note")
    print("  " + "-" * 48)

    started = time.time()
    frame_i = 0
    last_report = 0
    peak_people = 0
    intrusion_frames = 0
    intrusions = 0
    in_intrusion = False

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                # A live stream hiccups; wait briefly and retry rather than quit.
                time.sleep(0.2)
                if args.seconds and time.time() - started > args.seconds:
                    break
                continue

            frame_i += 1
            if frame_i % args.every:
                continue

            results = model(frame, verbose=False, conf=args.conf)[0]
            h, w = frame.shape[:2]
            counts = Counter()
            people_in_zone = 0

            for box in results.boxes:
                name = model.names[int(box.cls)]
                kind = PLANT_CLASSES.get(name)
                if not kind:
                    continue
                counts[kind] += 1
                if name == "person" and args.zone:
                    x1, y1, x2, y2 = [int(v) for v in box.xyxy[0]]
                    cx = (x1 + x2) / 2
                    if w * 0.25 < cx < w * 0.75:
                        people_in_zone += 1

            people = counts.get("person", 0)
            vehicles = counts.get("vehicle", 0)
            peak_people = max(peak_people, people)

            alerting = (people_in_zone if args.zone else people) > 0
            note = ""
            if alerting:
                intrusion_frames += 1
                if not in_intrusion:
                    intrusions += 1
                    in_intrusion = True
                    note = "*** INTRUSION: person detected"
                    if args.zone:
                        note += f" in zone ({people_in_zone})"
            else:
                in_intrusion = False

            now = time.time()
            if note or now - last_report >= 2:
                el = int(now - started)
                print(f"  {str(el)+'s':<8} {people:^6}  {vehicles:^8}  {note}")
                last_report = now

            if args.seconds and now - started > args.seconds:
                break
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        cap.release()

    dur = int(time.time() - started)
    print("\n  " + "-" * 48)
    print(f"  Watched:          {dur}s")
    print(f"  Peak people:      {peak_people}")
    print(f"  Intrusion events: {intrusions}")
    print(f"  Frames w/ person: {intrusion_frames}")
    if peak_people == 0 and vehicles == 0:
        print("\n  Saw nothing. Either the view is genuinely empty, or the camera")
        print("  is too dark / high-angle for yolov8n. Try a camera with people in")
        print("  frame, or --conf 0.25 to loosen detection.")
    else:
        print("\n  YOLO is seeing the plant. The detection core works on this footage.")
    print("")


if __name__ == "__main__":
    main()
