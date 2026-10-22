import { useEffect, useState } from 'react';
import { api, type SavedLink } from '../api';
import { CopyButton } from './CopyButton';

export function QuickLink() {
  const [saved, setSaved] = useState<SavedLink[]>([]);
  const [url, setUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ links: SavedLink[] }>('/api/saved-links').then((r) => setSaved(r.links)).catch(() => undefined);
  }, []);

  const create = async () => {
    setError('');
    try {
      const r = await api<{ message: { _id: string }; trackedUrl: string }>('/api/links', {
        method: 'POST',
        body: { url, label, linkLabel },
      });
      setResult({ id: r.message._id, url: r.trackedUrl });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="narrow">
      <div className="card form">
        <h2>Tracked link</h2>
        <p className="muted small">
          A link of its own, for LinkedIn messages, application forms or anywhere else. Make one per person so a click tells you
          who.
        </p>
        {saved.length > 0 && (
          <div className="chips">
            {saved.map((l) => (
              <button
                key={l.label}
                className={url === l.url ? 'chip on' : 'chip'}
                onClick={() => (setUrl(l.url), setLinkLabel(l.label))}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}
        <label>
          Destination
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://drive.google.com/file/d/…" />
        </label>
        <label>
          Who is it for?
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Jane Doe · Cardboard (LinkedIn)" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="primary" onClick={create} disabled={!url || !label}>
            Create link
          </button>
        </div>
        {result && (
          <div className="result">
            <code>{result.url}</code>
            <CopyButton text={result.url} />
            <a href={`#/m/${result.id}`} className="small">
              View activity
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
