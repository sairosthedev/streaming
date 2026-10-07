# PTZ API — steering a camera from another system

The Titan camera server exposes pan/tilt/zoom for cameras that have `ptz` set in the registry (today: `ptz-28-1`, the moving lens of the Hikvision dome at 192.168.89.28). This is the contract for an external caller such as the plant dashboard.

## Base URL and auth

| | |
|---|---|
| Online | `https://camera.titancctv.xyz` (needs `npm run tunnel` on the camera PC) |
| Local | `http://192.168.89.202:8080` |

Every `/api/ptz/*` request must carry the PTZ key, either as `?key=<PTZ_KEY>` or as `Authorization: Bearer <PTZ_KEY>`. The key is the `PTZ_KEY` value in the camera server's `.env`; store it as a secret (e.g. `TITAN_PTZ_KEY`) on the calling side. It is **not** the stream key in the `.mp4` URLs and **not** the viewer password — no login, no cookies, no session to keep alive. Pass the key on every call.

Without a valid key the response is `401 {"error":"unauthorized"}`.

## Endpoints

`<cam>` is the camera name, e.g. `ptz-28-1`. All bodies and responses are JSON.

| Method | Path | Body | Does |
|---|---|---|---|
| `POST` | `/api/ptz/<cam>/move` | `{"pan":-100..100,"tilt":-100..100,"zoom":-100..100}` | Starts moving at that speed. Positive pan = right, positive tilt = up, positive zoom = in. The camera keeps moving until `/stop`, **or for 2 s after the last `/move`, whichever is first** (server-side dead-man). To hold a direction, repeat `/move` at least once a second. |
| `POST` | `/api/ptz/<cam>/stop` | — | Stops all axes. |
| `GET` | `/api/ptz/<cam>/presets` | — | `{"presets":[{"id":1,"name":"Counting position"}, …]}`. Ids 1–32 are user slots; 33+ are the camera's built-ins (Auto-flip, patrols, Day/Night mode). |
| `POST` | `/api/ptz/<cam>/preset/<id>` | — | Goes to that preset. Takes ~1–3 s to arrive. |
| `POST` | `/api/ptz/<cam>/preset/<id>/save` | `{"name":"…"}` | Stores the *current* position as preset `<id>` (1–32). Overwrites. |
| `GET` | `/api/ptz/<cam>/status` | — | `{"azimuth":323,"elevation":-3,"zoom":1}` — degrees and zoom multiplier. Use it to confirm the camera is where you expect. |
| `POST` | `/api/ptz/<cam>/absolute` | `{"azimuth":0..360,"elevation":-10..90,"zoom":1..25}` | Aims at exact values, same units as `/status`. Arrives in ~1–3 s. |
| `POST` | `/api/ptz/<cam>/look` | `{"x":0..1,"y":0..1,"w"?:0..1,"h"?:0..1}` | **Set the focus point from an image click.** `x`,`y` are fractions of the `ptz-28-1` frame, origin top-left; the camera re-centres on that point. Add `w`,`h` (box size as fractions) to also zoom so the box fills the view. `{x:0.5,y:0.5}` = stay put. Measured: `{x:0.25,y:0.35}` at 1× panned left 13.4° and up 4.6°; a 25 % box zoomed to 4×. |
| `GET` | `/api/ptz/<cam>/park` | — | `{"enabled":false,"seconds":5,"preset":1,"action":"preset"}` — the camera's own "return to preset after idle" rule. |
| `POST` | `/api/ptz/<cam>/park` | `{"enabled":true,"seconds":5..720,"preset":1..300}` | Sets that rule. With `enabled:true, seconds:60, preset:1` the camera goes back to the counting position by itself 60 s after the last PTZ command, even if Titan or the dashboard is down. Returns the new state. **Currently disabled** — turn it on when you are ready. |

Success is `200 {"ok":true}` (or the data above). Errors:

| Status | Meaning |
|---|---|
| `400 {"error":"camera has no PTZ control"}` | That camera is fixed (e.g. `ptz-28-2`, `cam-113`). |
| `404 {"error":"no such camera"}` | Unknown name. |
| `502 {"error":"…"}` | The camera itself refused or did not answer; message is the camera's reason. |

## The counting position

Preset **1, "Counting position"** on `ptz-28-1` is the view the counting zones were drawn against (azimuth 323.0°, elevation −3.0°, zoom 1×). To put the camera back where the model expects it:

```
POST /api/ptz/ptz-28-1/preset/1
```

Then, if you want to be sure before counting starts, poll `/status` until it reports those values (±0.5°).

If the camera is ever re-aimed on purpose, re-save the preset from the new position (`/preset/1/save` or the "Save here" button in the Titan player) **and** redraw the zones — the two must match.

## Examples

```bash
# where is it
curl "https://camera.titancctv.xyz/api/ptz/ptz-28-1/status?key=$TITAN_PTZ_KEY"

# back to the counting position
curl -X POST -H "Authorization: Bearer $TITAN_PTZ_KEY" \
  https://camera.titancctv.xyz/api/ptz/ptz-28-1/preset/1

# nudge right for half a second
curl -X POST -H "Authorization: Bearer $TITAN_PTZ_KEY" -H "Content-Type: application/json" \
  -d '{"pan":30}' https://camera.titancctv.xyz/api/ptz/ptz-28-1/move
sleep 0.5
curl -X POST -H "Authorization: Bearer $TITAN_PTZ_KEY" \
  https://camera.titancctv.xyz/api/ptz/ptz-28-1/stop
```

Hold-to-move from a browser pad: send `/move` on press and every second while held, `/stop` on release. If the client dies mid-hold, the dead-man stops the camera within 2 s.

## Auto-tracking: what the camera can and cannot do

Checked against the camera's own capability reports (model DS-2SE4C425MWG-E, firmware V5.8.2) — read-only queries, nothing was switched on.

1. **Built-in auto-tracking: not available through the API.** The PTZ and Smart capability lists carry no auto-track / smart-track feature (`isSupportIntelliTrace=false`, no tracking endpoint answers). The only tracking the camera reports is *manual* linkage on the wide lens (`isSupportManualTrack` on channel 2: click a target in the wide view, the PTZ lens turns to it), which is a one-shot move, not a follow. So there is no `/autotrack {"on":true}` to expose and nothing for `/status` to report.

2. **What works instead: the dashboard tracks, the camera obeys.** The dashboard already runs detection on every frame, so it can follow the spout itself: when the discharge point drifts from centre, call `/look` with its frame position (or `/move` for a short nudge), at most a few times a minute. This is "auto-tracking" with the dashboard as the brain, and it stays entirely under the dashboard's control — on only during a load, off otherwise.

3. **Keeping it in the loading zone and falling back when idle:**
   - *Fallback:* `POST /park {"enabled":true,"seconds":60,"preset":1}` makes the camera itself return to the counting position after 60 s without commands. This is the strongest safeguard because it does not depend on any server being up.
   - *Limits:* the camera supports manual pan/tilt limits (`ptzLimiteds`, one limit set per lens). They are set once in the camera's web UI (Configuration → PTZ → Limits: aim at each edge and press Set). Once set, no `/move` or `/look` can leave that box. Not exposed via this API yet; ask if you want it.
   - *Don't chase people/trucks:* nothing in the camera will chase anything on its own; it only moves when told. Whatever the dashboard sends to `/look` is what it follows, so the filter belongs in the dashboard's detector (only steer on the spout/bag class, inside the loading-bay region).

Any move — including `/look` — changes where pixels land, so the zone caveat still holds: count on the counting position, or make the zones relative to the detected spout rather than fixed pixels.

## Notes for the dashboard

- Only one key, shared by all PTZ cameras; names come from the Titan picker (`/api/cameras` needs the viewer login, so hard-code `ptz-28-1` or have Titan's operator tell you the names).
- Commands from several clients are not serialised; the last `/move` wins. Keep the pad to one operator at a time.
- Moving a camera invalidates pixel-based zones for as long as it is moved. Auto-return on shift open is the right safeguard; a `/status` check before counting is the belt to that brace.
