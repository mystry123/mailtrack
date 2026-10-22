import { useState } from 'react';
import { api, RELATIONSHIP_LABEL, type Application, type FoundPeople, type Person } from '../api';
import { Modal, useApi } from '../components';
import { Icon } from '../icons';

const fmt = (p: { name?: string; email: string }) => (p.name ? `${p.name} <${p.email}>` : p.email);

export function PersonForm({
  initial,
  onSaved,
  onClose,
}: {
  initial: Partial<Person>;
  onSaved: (p: Person) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<Partial<Person>>({ relationship: 'other', ...initial });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Person) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { name: f.name ?? '', email: f.email ?? '', company: f.company ?? '', title: f.title ?? '', linkedin: f.linkedin ?? '', relationship: f.relationship, notes: f.notes ?? '', applicationIds: f.applicationIds ?? [] };
      const r = f._id
        ? await api<{ contact: Person }>(`/api/contacts/${f._id}`, { method: 'PATCH', body })
        : await api<{ contact: Person }>('/api/contacts', { method: 'POST', body });
      onSaved(r.contact);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={f._id ? 'Edit person' : 'Add a person'} onClose={onClose}>
      <div className="form">
        <div className="two">
          <label>
            Name
            <input autoFocus value={f.name ?? ''} onChange={set('name')} />
          </label>
          <label>
            Email
            <input value={f.email ?? ''} onChange={set('email')} placeholder="name@company.com" />
          </label>
        </div>
        <div className="two">
          <label>
            Company
            <input value={f.company ?? ''} onChange={set('company')} />
          </label>
          <label>
            Title
            <input value={f.title ?? ''} onChange={set('title')} placeholder="Engineering Manager" />
          </label>
        </div>
        <div className="two">
          <label>
            Relationship
            <select value={f.relationship} onChange={set('relationship')}>
              {Object.entries(RELATIONSHIP_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            LinkedIn
            <input value={f.linkedin ?? ''} onChange={set('linkedin')} placeholder="https://linkedin.com/in/…" />
          </label>
        </div>
        <label>
          Notes
          <textarea rows={3} value={f.notes ?? ''} onChange={set('notes')} placeholder="How you know them, what you talked about" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={save} disabled={busy || (!f.name?.trim() && !f.email?.trim())}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function PeopleCard({ app, onToast }: { app: Application; onToast: (m: string) => void }) {
  const { data, reload } = useApi<{ contacts: Person[] }>(`/api/contacts?applicationId=${app._id}`);
  const [editing, setEditing] = useState<Partial<Person> | null>(null);
  const [finding, setFinding] = useState(false);
  const [domain, setDomain] = useState('');
  const [found, setFound] = useState<FoundPeople | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const find = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<FoundPeople>(`/api/applications/${app._id}/people`, { method: 'POST', body: { domain } });
      setFound(r);
      if (r.domain) setDomain(r.domain);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveFound = async (name: string, title: string, email: string) => {
    try {
      await api('/api/contacts', { method: 'POST', body: { name, title, email, company: app.company, relationship: /founder|ceo|cto/i.test(title) ? 'founder' : 'other', applicationIds: [app._id] } });
      onToast(`Saved ${name}`);
      reload();
    } catch (e) {
      onToast((e as Error).message);
    }
  };

  const people = data?.contacts ?? [];
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <Icon name="briefcase" size={15} /> People
        </h2>
        <div className="head-actions">
          <button className="ghost small" onClick={() => setEditing({ company: app.company, applicationIds: [app._id] })}>
            + Add
          </button>
          <button className="small" onClick={() => setFinding(!finding)}>
            Find who to email
          </button>
        </div>
      </div>

      {people.length === 0 && !finding && <p className="small muted">Nobody yet. People you email here are added automatically.</p>}
      <ul className="people">
        {people.map((p) => (
          <li key={p._id}>
            <div className="person-main">
              <strong>{p.name || p.email}</strong>
              <span className="small muted">
                {[p.title, RELATIONSHIP_LABEL[p.relationship]].filter(Boolean).join(' · ')}
                {p.email && p.name ? ` · ${p.email}` : ''}
              </span>
            </div>
            <div className="person-actions">
              {p.email && (
                <a className="button small ghost" href={`#/compose?app=${app._id}&to=${encodeURIComponent(fmt(p))}`}>
                  Email
                </a>
              )}
              {p.email && (
                <a className="button small ghost" href={`#/compose?referral=${p._id}&app=${app._id}`} title="Gemini drafts a referral ask">
                  Ask for referral
                </a>
              )}
              <button className="icon-btn" aria-label={`Edit ${p.name || p.email}`} onClick={() => setEditing(p)}>
                <Icon name="pen" size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>

      {finding && (
        <div className="finder">
          <div className="finder-row">
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="company domain, e.g. cardboard.ai (optional)" onKeyDown={(e) => e.key === 'Enter' && find()} />
            <button className="primary small" onClick={find} disabled={busy}>
              {busy ? 'Searching…' : 'Search'}
            </button>
          </div>
          <p className="small muted">Gemini searches the web for founders and hiring managers; addresses are guessed from common patterns (and from people you've already emailed there).</p>
          {error && <p className="small error">{error}</p>}
          {found?.needDomain && <p className="small error">Add the company's website domain so we can suggest addresses.</p>}
          {found && found.domain && !found.mailOk && <p className="small error">{found.domain} doesn't seem to receive email: check the domain.</p>}
          {found && found.people.length === 0 && <p className="small muted">No one found. Try adding a name in “+ Add”.</p>}
          {found?.people.map((p) => (
            <div key={p.name} className="found">
              <div>
                <strong>{p.name}</strong> <span className="small muted">{p.title}</span>
              </div>
              {p.emails.map((e) => (
                <div key={e.email} className="found-email">
                  <code>{e.email}</code>
                  <span className={`conf ${e.confidence}`}>{e.confidence}</span>
                  <span className="small muted">{e.why}</span>
                  <span className="found-actions">
                    <button className="ghost small" onClick={() => saveFound(p.name, p.title, e.email)}>
                      Save
                    </button>
                    <a className="button small ghost" href={`#/compose?app=${app._id}&to=${encodeURIComponent(fmt({ name: p.name, email: e.email }))}`}>
                      Email
                    </a>
                  </span>
                </div>
              ))}
            </div>
          ))}
          {(found?.sources.length ?? 0) > 0 && (
            <div className="sources small">
              Sources:{' '}
              {found!.sources.map((s, i) => (
                <a key={i} href={s.url} target="_blank" rel="noreferrer">
                  {s.title || `source ${i + 1}`}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {editing && (
        <PersonForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            onToast(`Saved ${p.name || p.email}`);
            reload();
          }}
        />
      )}
    </section>
  );
}
