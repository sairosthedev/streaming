'use client';

import { useEffect, useState } from 'react';
import Player from './Player';

export default function Gate() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        setAuthed(!cfg.requiresPassword || cfg.authenticated);
        setReady(true);
      })
      .catch(() => setReady(true));
  }, []);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');

    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    setBusy(false);

    if (res.ok) {
      setAuthed(true);
    } else {
      setError('Wrong password.');
      setPassword('');
    }
  }

  if (!ready) return null;
  if (authed) return <Player />;

  return (
    <div className="shell">
      <div className="bar">
        <span className="dot" />
        <h1>Live Camera</h1>
        <span className="status">Locked</span>
      </div>

      <div className="stage">
        <div className="overlay">
          <div>
            <p style={{ marginBottom: 16 }}>This feed is password protected.</p>
            <form onSubmit={login}>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                autoFocus
              />
              <button type="submit" disabled={busy || !password}>
                {busy ? '...' : 'Watch'}
              </button>
            </form>
            <div className="err">{error}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
