import { useEffect, useState } from 'react';
import { api, type Application, type SavedLink } from '../api';
import { AppPicker, type PickedApp } from '../components';
import { Icon } from '../icons';
import { CopyButton } from './CopyButton';

export function QuickLink({ params }: { params: URLSearchParams }) {
  const [saved, setSaved] = useState<SavedLink[]>([]);
  const [apps, setApps] = useState<Application[]>([]);
  const [url, setUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [label, setLabel] = useState('');
  const [app, setApp] = useState<PickedApp>(() => (params.get('app') ? { applicationId: params.get('app')! } : {}));
  const [result, setResult] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ links: SavedLink[] }>('/api/saved-links').then((r) => setSaved(r.links)).catch(() => undefined);
    api<{ applications: Application[] }>('/api/applications').then((r) => setApps(r.applications)).catch(() => undefined);
  }, []);

  const create = async () => {
    setError('');
    try {
      const r = await api<{ message: { _id: string }; trackedUrl: string }>('/api/links', {
        method: 'POST',
        body: { url, label, linkLabel, ...app },
      });
      setResult({ id: r.message._id, url: r.trackedUrl });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page narrow">
      <header className="page-head">
        <div>
          <h1>Tracked link</h1>
          <p className="muted">For LinkedIn messages, application forms or anywhere else. Make one per person so a click tells you who.</p>
        </div>
      </header>
      <div className="card form">
        {saved.length > 0 && (
          <div className="chips">
            {saved.map((l) => (
              <button key={l.label} className={url === l.url ? 'chip on' : 'chip'} onClick={() => (setUrl(l.url), setLinkLabel(l.label))}>
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
        <label>
          Company <span className="muted">(optional: adds it to the pipeline)</span>
          <AppPicker value={app} apps={apps} onChange={({ label: _l, ...a }) => setApp(a)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="primary" onClick={create} disabled={!url || !label}>
            <Icon name="link" size={15} /> Create link
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
    </div>
  );
}
