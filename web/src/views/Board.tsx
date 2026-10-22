import { useMemo, useState } from 'react';
import {
  CLOSED_STAGES,
  OPEN_STAGES,
  SOURCE_LABEL,
  SOURCES,
  STAGE_HINT,
  STAGE_LABEL,
  STAGES,
  type Source,
  type Stage,
} from '../../../src/shared/stages';
import { api, type Application } from '../api';
import { Empty, ImportBanner, Logo, Modal, StageBadge, Stars, Toast, useApi } from '../components';
import { ago, when } from '../format';
import { Icon } from '../icons';
import { go } from '../nav';

const VIEW_KEY = 'mailtrack:board-view';

function readView(): 'board' | 'list' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

function Card({ a, onDragStart }: { a: Application; onDragStart: (id: string) => void }) {
  const act = a.activity;
  return (
    <div
      className="job-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', a._id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(a._id);
      }}
      onDragEnd={() => onDragStart('')}
      onClick={() => go(`/a/${a._id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && go(`/a/${a._id}`)}
    >
      <div className="job-top">
        <Logo name={a.company} size={28} />
        <div className="job-name">
          <strong>{a.company}</strong>
          <span className="muted small">{a.role || 'Role not set'}</span>
        </div>
        <Stars value={a.priority} />
      </div>
      {a.interviewAt && new Date(a.interviewAt).getTime() > Date.now() - 86_400_000 && (
        <div className="job-interview">
          <Icon name="calendar" size={13} /> {when(a.interviewAt)}
        </div>
      )}
      <div className="job-signals">
        {act && act.emails > 0 && <span title="Emails sent">✉ {act.emails}</span>}
        {act && act.opens > 0 && <span className="sig open" title="Opens">◉ {act.opens}</span>}
        {act && act.clicks > 0 && <span className="sig click" title="Clicks">↗ {act.clicks}</span>}
        {act && act.replies > 0 && <span className="sig reply" title="Replies">↩ {act.replies}</span>}
        {act && act.scheduled > 0 && <span title="Scheduled">⏱ {act.scheduled}</span>}
        <span className="job-age">{ago(act?.lastActivityAt ?? a.updatedAt)}</span>
      </div>
    </div>
  );
}

export function Board() {
  const [archived, setArchived] = useState(false);
  const { data, error, reload, setData } = useApi<{ applications: Application[] }>(`/api/applications?archived=${archived ? 1 : 0}`, 60_000);
  const [view, setView] = useState<'board' | 'list'>(readView);
  const [q, setQ] = useState('');
  const [source, setSource] = useState<Source | ''>('');
  const [dragging, setDragging] = useState('');
  const [over, setOver] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [adding, setAdding] = useState<Stage | null>(null);
  const [toast, setToast] = useState('');

  const apps = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.applications ?? []).filter(
      (a) =>
        (!s || a.company.toLowerCase().includes(s) || a.role.toLowerCase().includes(s) || a.location.toLowerCase().includes(s)) &&
        (!source || a.source === source),
    );
  }, [data, q, source]);

  const switchView = (v: 'board' | 'list') => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // ignore
    }
  };

  const move = async (id: string, stage: Stage) => {
    const app = data?.applications.find((a) => a._id === id);
    if (!app || app.stage === stage) return;
    // Optimistic: move the card now, reload to get the server's view.
    setData((d) => (d ? { applications: d.applications.map((a) => (a._id === id ? { ...a, stage } : a)) } : d));
    try {
      await api(`/api/applications/${id}`, { method: 'PATCH', body: { stage } });
      setToast(`${app.company} → ${STAGE_LABEL[stage]}`);
    } catch (e) {
      setToast((e as Error).message);
    }
    reload();
  };

  const column = (stage: Stage) => {
    const items = apps.filter((a) => a.stage === stage).sort((a, b) => b.priority - a.priority);
    return (
      <div
        key={stage}
        className={`column${over === stage ? ' over' : ''}${items.length === 0 && !dragging ? ' collapsed' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(stage);
        }}
        onDragLeave={() => setOver((o) => (o === stage ? null : o))}
        onDrop={(e) => {
          e.preventDefault();
          setOver(null);
          const id = e.dataTransfer.getData('text/plain') || dragging;
          if (id) void move(id, stage);
        }}
      >
        <div className="column-head" title={STAGE_HINT[stage]}>
          <StageBadge stage={stage} />
          <span className="column-count">{items.length}</span>
          <button className="icon-btn" title={`Add to ${STAGE_LABEL[stage]}`} onClick={() => setAdding(stage)}>
            <Icon name="plus" size={15} />
          </button>
        </div>
        <div className="column-body">
          {items.map((a) => (
            <Card key={a._id} a={a} onDragStart={setDragging} />
          ))}
          {items.length === 0 && <div className="column-empty">{dragging ? 'Drop here' : 'Empty'}</div>}
        </div>
      </div>
    );
  };

  return (
    <div className="page wide">
      <header className="page-head">
        <div>
          <h1>Pipeline</h1>
          <p className="muted">Drag a card to move it. Sending an email or getting a reply moves it for you.</p>
        </div>
        <div className="head-actions">
          <div className="seg">
            <button className={view === 'board' ? 'on' : ''} onClick={() => switchView('board')}>
              Board
            </button>
            <button className={view === 'list' ? 'on' : ''} onClick={() => switchView('list')}>
              List
            </button>
          </div>
          <button className="primary" onClick={() => setAdding('wishlist')}>
            <Icon name="plus" size={15} /> Add job
          </button>
        </div>
      </header>

      <div className="toolbar">
        <div className="search-box">
          <Icon name="search" size={15} />
          <input placeholder="Search company, role, location" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select value={source} onChange={(e) => setSource(e.target.value as Source | '')} aria-label="Source">
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
        {view === 'board' && (
          <label className="check">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Closed columns
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      <ImportBanner
        onDone={(m) => {
          setToast(m);
          reload();
        }}
      />
      {!data ? (
        <p className="muted">Loading…</p>
      ) : data.applications.length === 0 ? (
        <div className="card">
          <Empty icon="▦" title="Your pipeline is empty">
            Add the companies you're going after, or just send an email: picking a company in Compose creates the card for you.
            <div style={{ marginTop: 12 }}>
              <button className="primary" onClick={() => setAdding('wishlist')}>
                Add your first job
              </button>
            </div>
          </Empty>
        </div>
      ) : view === 'board' ? (
        <div className="board">
          {OPEN_STAGES.map(column)}
          {showClosed && CLOSED_STAGES.map(column)}
        </div>
      ) : (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Stage</th>
                <th className="hide-sm">Source</th>
                <th className="hide-sm">Activity</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {apps
                .slice()
                .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage))
                .map((a) => (
                  <tr key={a._id} onClick={() => go(`/a/${a._id}`)}>
                    <td>
                      <div className="cell-co">
                        <Logo name={a.company} size={26} />
                        <div>
                          <strong>{a.company}</strong>
                          <div className="muted small">{a.role || '—'}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <StageBadge stage={a.stage} />
                    </td>
                    <td className="hide-sm muted">{SOURCE_LABEL[a.source]}</td>
                    <td className="hide-sm muted small">
                      {a.activity?.emails ?? 0} sent · {a.activity?.opens ?? 0} opens · {a.activity?.clicks ?? 0} clicks · {a.activity?.replies ?? 0}{' '}
                      replies
                    </td>
                    <td className="muted">{ago(a.activity?.lastActivityAt ?? a.updatedAt)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddJob
          stage={adding}
          onClose={() => setAdding(null)}
          onAdded={(company) => {
            setAdding(null);
            setToast(`Added ${company}`);
            reload();
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast('')} />}
    </div>
  );
}

export function AddJob({ stage, onClose, onAdded }: { stage: Stage; onClose: () => void; onAdded: (company: string) => void }) {
  const [f, setF] = useState({ company: '', role: '', jobUrl: '', source: 'cold_email' as Source, location: '', stage, jobDescription: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/applications', { method: 'POST', body: f });
      onAdded(f.company);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a job" onClose={onClose}>
      <div className="form">
        <div className="two">
          <label>
            Company
            <input autoFocus value={f.company} onChange={set('company')} placeholder="Cardboard" />
          </label>
          <label>
            Role
            <input value={f.role} onChange={set('role')} placeholder="Founding fullstack engineer" />
          </label>
        </div>
        <label>
          Job link
          <input value={f.jobUrl} onChange={set('jobUrl')} placeholder="https://…" />
        </label>
        <div className="three">
          <label>
            Source
            <select value={f.source} onChange={set('source')}>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Stage
            <select value={f.stage} onChange={set('stage')}>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Location
            <input value={f.location} onChange={set('location')} placeholder="Remote / Bengaluru" />
          </label>
        </div>
        <label>
          Job description <span className="muted">(optional; Gemini uses it to tailor emails and prep)</span>
          <textarea rows={4} value={f.jobDescription} onChange={set('jobDescription')} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={save} disabled={busy || !f.company.trim()}>
            Add job
          </button>
        </div>
      </div>
    </Modal>
  );
}
