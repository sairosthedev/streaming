from flask import Flask, jsonify
import threading
import time

app = Flask(__name__)

@app.route("/")
def hello():
    return {"status": "ok"}

@app.route("/api/state")
def state():
    return {"test": "value"}

if __name__ == "__main__":
    print("Starting Flask on port 8092...")
    app.run(host="0.0.0.0", port=8092, threaded=True)
