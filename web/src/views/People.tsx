import { useMemo, useState } from 'react';
import { RELATIONSHIP_LABEL, type Application, type Person } from '../api';
import { Empty, Logo, Toast, useApi } from '../components';
import { ago } from '../format';
import { Icon } from '../icons';
import { PersonForm } from './PeopleCard';

const fmt = (p: Person) => (p.name ? `${p.name} <${p.email}>` : p.email);

export function People() {
  const [q, setQ] = useState('');
  const [rel, setRel] = useState('');
  const { data, error, reload } = useApi<{ contacts: Person[] }>('/api/contacts');
  const apps = useApi<{ applications: Application[] }>('/api/applications').data?.applications ?? [];
  const [editing, setEditing] = useState<Partial<Person> | null>(null);
  const [toast, setToast] = useState('');

  const people = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.contacts ?? []).filter(
      (p) => (!rel || p.relationship === rel) && (!s || [p.name, p.email, p.company, p.title].some((x) => x.toLowerCase().includes(s))),
    );
  }, [data, q, rel]);
  const appName = (id: string) => apps.find((a) => a._id === id)?.company;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>People</h1>
          <p className="muted">Everyone you've emailed, plus friends and ex-colleagues who could refer you. Referrals turn into offers more often than cold applications.</p>
        </div>
        <button className="primary" onClick={() => setEditing({ relationship: 'friend' })}>
          <Icon name="plus" size={15} /> Add person
        </button>
      </header>

      <div className="toolbar">
        <div className="search-box">
          <Icon name="search" size={15} />
          <input placeholder="Search name, email, company" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select value={rel} onChange={(e) => setRel(e.target.value)} aria-label="Relationship">
          <option value="">Everyone</option>
          {Object.entries(RELATIONSHIP_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error">{error}</p>}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : people.length === 0 ? (
        <div className="card">
          <Empty icon="☺" title={data.contacts.length ? 'No one matches' : 'No people yet'}>
            Everyone you email is added here automatically. Add friends and ex-colleagues at companies you like, then ask them for a referral.
          </Empty>
        </div>
      ) : (
        <div className="card rows">
          {people.map((p) => (
            <div key={p._id} className="row person-row">
              <Logo name={p.company || p.name || p.email} size={32} />
              <span className="row-main">
                <span className="row-who">
                  {p.name || p.email}
                  <span className="tag">{RELATIONSHIP_LABEL[p.relationship]}</span>
                </span>
                <span className="row-sub muted">
                  {[p.title, p.company, p.name ? p.email : ''].filter(Boolean).join(' · ')}
                  {(() => {
                    const names = p.applicationIds.map(appName).filter((n): n is string => !!n && n.toLowerCase() !== p.company.toLowerCase());
                    return names.length ? ` · ${names.join(', ')}` : '';
                  })()}
                </span>
              </span>
              <span className="row-time muted">{p.lastContactAt ? `emailed ${ago(p.lastContactAt)}` : 'not emailed'}</span>
              <span className="person-actions">
                {p.email && (
                  <a className="button small ghost" href={`#/compose?to=${encodeURIComponent(fmt(p))}${p.applicationIds[0] ? `&app=${p.applicationIds[0]}` : ''}`}>
                    Email
                  </a>
                )}
                {p.email && (
                  <a
                    className={p.relationship === 'friend' || p.relationship === 'referral' ? 'button small' : 'button small ghost'}
                    href={`#/compose?referral=${p._id}${p.applicationIds[0] ? `&app=${p.applicationIds[0]}` : ''}`}
                  >
                    Ask for referral
                  </a>
                )}
                <button className="icon-btn" aria-label={`Edit ${p.name || p.email}`} onClick={() => setEditing(p)}>
                  <Icon name="pen" size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <PersonForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            setToast(`Saved ${p.name || p.email}`);
            reload();
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast('')} />}
    </div>
  );
}
