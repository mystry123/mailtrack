import { useEffect, useState } from 'react';
import { api, type Me, type SavedLink } from '../api';

export function Settings({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [fromName, setFromName] = useState(me.fromName || me.name);
  const [links, setLinks] = useState<SavedLink[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ links: SavedLink[] }>('/api/saved-links').then((r) => setLinks(r.links)).catch((e) => setError(e.message));
  }, []);

  const update = (i: number, patch: Partial<SavedLink>) => setLinks(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    setError('');
    setStatus('');
    try {
      await api('/api/me', { method: 'PUT', body: { fromName } });
      const clean = links.filter((l) => l.label.trim() || l.url.trim());
      const r = await api<{ links: SavedLink[] }>('/api/saved-links', { method: 'PUT', body: { links: clean } });
      setLinks(r.links);
      setStatus('Saved');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="narrow">
      <div className="card form">
        <h2>Sender</h2>
        <label>
          From name
          <input value={fromName} onChange={(e) => setFromName(e.target.value)} />
        </label>
        <p className="small muted">
          Sending as {me.email}. <a href="/auth/google">Reconnect Google</a> if sending ever fails.
        </p>
      </div>

      <div className="card form">
        <h2>Saved links</h2>
        <p className="small muted">One-click inserts for Compose and Tracked link: resume, demo, portfolio.</p>
        {links.map((l, i) => (
          <div key={i} className="saved-row">
            <input value={l.label} placeholder="Resume" onChange={(e) => update(i, { label: e.target.value })} />
            <input value={l.url} placeholder="https://drive.google.com/…" onChange={(e) => update(i, { url: e.target.value })} />
            <button className="ghost small" onClick={() => setLinks(links.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button className="ghost" onClick={() => setLinks([...links, { label: '', url: '' }])}>
          + Add link
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      <div className="actions">
        {status && <span className="muted small">{status}</span>}
        <button className="primary" onClick={save}>
          Save settings
        </button>
      </div>
    </section>
  );
}
