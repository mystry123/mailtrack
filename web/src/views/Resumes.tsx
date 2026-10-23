import { useState } from 'react';
import { api, type Resume } from '../api';
import { useApi } from '../components';
import { ago } from '../format';

// Your resume versions. Compose suggests the one that fits each job; the link goes out as is (straight to Drive).
export function Resumes({ onToast }: { onToast: (m: string) => void }) {
  const { data, reload } = useApi<{ resumes: Resume[] }>('/api/resumes');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const add = async () => {
    setBusy('add');
    setError('');
    try {
      const r = await api<{ resume: Resume }>('/api/resumes', { method: 'POST', body: { name, url } });
      onToast(r.resume.readError ? `Added ${name}, but couldn’t read it` : `Added ${name}`);
      setName('');
      setUrl('');
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const reread = async (r: Resume) => {
    setBusy(r._id);
    try {
      const res = await api<{ resume: Resume }>(`/api/resumes/${r._id}/read`, { method: 'POST' });
      onToast(res.resume.readError ? `Still can’t read ${r.name}` : `Read ${r.name}`);
      reload();
    } finally {
      setBusy('');
    }
  };

  const remove = async (r: Resume) => {
    if (!window.confirm(`Remove ${r.name}? Emails already sent keep their link.`)) return;
    await api(`/api/resumes/${r._id}`, { method: 'DELETE' });
    onToast(`Removed ${r.name}`);
    reload();
  };

  return (
    <section className="card form">
      <h2>Resumes</h2>
      <p className="small muted">
        Add each version as a Google Drive (PDF) or Google Docs link shared as <strong>Anyone with the link</strong>. Mailtrack reads it once so Gemini can
        suggest the best one for each job in Compose. The link goes out as is, straight to Drive.
      </p>
      <div className="invite-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="AI Engineer" aria-label="Resume name" />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://drive.google.com/file/d/…/view"
          aria-label="Drive link"
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && url.trim() && add()}
        />
        <button className="primary" onClick={add} disabled={!!busy || !name.trim() || !url.trim()}>
          {busy === 'add' ? 'Reading…' : 'Add'}
        </button>
      </div>
      {error && <p className="small error">{error}</p>}
      {data && data.resumes.length > 0 && (
        <ul className="task-list">
          {data.resumes.map((r) => (
            <li key={r._id} className="task">
              <div className="task-main">
                <strong>{r.name}</strong>{' '}
                <a className="small" href={r.url} target="_blank" rel="noreferrer">
                  Open
                </a>
                <div className={r.readError ? 'small error' : 'small muted'}>
                  {r.readError || `Read ${r.pages ? `${r.pages} page${r.pages > 1 ? 's' : ''}` : ''} ${r.readAt ? ago(r.readAt) : ''}`.trim()}
                </div>
              </div>
              <button className="ghost small" disabled={!!busy} onClick={() => reread(r)} title="After changing the file or its sharing in Drive">
                {busy === r._id ? 'Reading…' : 'Read again'}
              </button>
              <button className="ghost small" onClick={() => remove(r)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
