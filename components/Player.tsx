'use client';

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

const PLAYLIST = '/api/stream/playlist';

type State = 'connecting' | 'live' | 'offline' | 'misconfigured' | 'error';

export default function Player() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>('connecting');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let cancelled = false;
    let poll: ReturnType<typeof setTimeout>;

    /**
     * The Vercel app can't start the camera — only the agent on the PC can.
     * So poll until the agent is actually pushing, then attach the player.
     * Attaching to an absent playlist just yields a confusing fatal error.
     */
    async function waitForAgent() {
      while (!cancelled) {
        try {
          const res = await fetch('/api/stream/status', { cache: 'no-store' });
          const s = await res.json();
          if (s.live) return true;
          setState(s.reason === 'blob-error' ? 'misconfigured' : 'offline');
        } catch {
          setState('error');
        }
        await new Promise((r) => {
          poll = setTimeout(r, 3000);
        });
      }
      return false;
    }

    function attach() {
      if (!video || cancelled) return;

      // Safari plays HLS natively; everything else needs hls.js.
      if (!Hls.isSupported()) {
        video.src = PLAYLIST;
        video.addEventListener('loadedmetadata', () => {
          video.play().catch(() => {});
          setState('live');
        });
        return;
      }

      hls = new Hls({
        liveSyncDurationCount: 3,
        manifestLoadingMaxRetry: Infinity,
        levelLoadingMaxRetry: Infinity,
        fragLoadingMaxRetry: Infinity,
      });

      hls.loadSource(PLAYLIST);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        setState('live');
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setState('connecting');
          hls?.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
        } else {
          setState('error');
          hls?.destroy();
        }
      });
    }

    (async () => {
      setState('connecting');
      if (await waitForAgent()) {
        setState('connecting');
        attach();
      }
    })();

    // A live feed drifting behind is worse than one that skips: snap to the
    // live edge if we fall too far back.
    const drift = setInterval(() => {
      if (!video.duration || video.paused) return;
      if (video.duration - video.currentTime > 12) {
        video.currentTime = video.duration - 1;
      }
    }, 5000);

    return () => {
      cancelled = true;
      clearTimeout(poll);
      clearInterval(drift);
      hls?.destroy();
    };
  }, []);

  const label = {
    connecting: 'Connecting...',
    live: 'Live',
    offline: 'Camera offline',
    misconfigured: 'Setup incomplete',
    error: 'Error',
  }[state];

  const dot = {
    connecting: 'wait',
    live: 'live',
    offline: 'error',
    misconfigured: 'error',
    error: 'error',
  }[state];

  return (
    <div className="shell">
      <div className="bar">
        <span className={`dot ${dot}`} />
        <h1>Live Camera</h1>
        <span className="status">{label}</span>
      </div>

      <div className="stage">
        <video ref={videoRef} playsInline muted autoPlay controls />

        {state !== 'live' && (
          <div className="overlay">
            <div>
              {state === 'offline' && (
                <>
                  <p>The camera agent isn&apos;t running.</p>
                  <p className="hint">
                    Start it on the PC that can see the camera:
                    <br />
                    <br />
                    <code>npm run agent</code>
                    <br />
                    <br />
                    This page will pick up the feed automatically.
                  </p>
                </>
              )}

              {state === 'misconfigured' && (
                <>
                  <p>Blob storage isn&apos;t reachable.</p>
                  <p className="hint">
                    The <code>BLOB_READ_WRITE_TOKEN</code> environment variable is
                    missing or wrong on this deployment. Check the Vercel project
                    settings.
                  </p>
                </>
              )}

              {(state === 'connecting' || state === 'error') && (
                <>
                  <div className="spinner" />
                  <p>
                    {state === 'error'
                      ? 'Connection problem'
                      : 'Connecting to camera...'}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="foot">
        <span>HLS &middot; ~10s behind live</span>
      </div>
    </div>
  );
}
