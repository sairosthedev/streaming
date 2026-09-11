#!/usr/bin/env python3
"""Quick test to see if Flask starts."""
import sys
print("Python started", file=sys.stderr)
sys.stderr.flush()

try:
    from flask import Flask
    print("Flask imported", file=sys.stderr)
    sys.stderr.flush()
except Exception as e:
    print(f"Flask import failed: {e}", file=sys.stderr)
    sys.exit(1)

try:
    app = Flask(__name__)
    print("Flask app created", file=sys.stderr)
    sys.stderr.flush()
except Exception as e:
    print(f"Flask app creation failed: {e}", file=sys.stderr)
    sys.exit(1)

@app.route("/")
def hello():
    return {"status": "ok"}

if __name__ == "__main__":
    print("Starting Flask...", file=sys.stderr)
    sys.stderr.flush()
    app.run(host="0.0.0.0", port=8092, threaded=True)
