import { useEffect, useMemo, useState } from 'react';
import { renderBody } from '../../../src/shared/render';
import {
  CLOSED_STAGES,
  OPEN_STAGES,
  SOURCE_LABEL,
  SOURCES,
  STAGE_LABEL,
  type Source,
  type Stage,
} from '../../../src/shared/stages';
import { api, type Application, type Contact, type Message, type TrackEvent } from '../api';
import { Logo, StageBadge, Stars, Toast, useApi } from '../components';
import { ago, statusOf, STATUS_LABEL, when } from '../format';
import { Icon } from '../icons';
import { go } from '../nav';

interface Data {
  application: Application;
  messages: Message[];
  events: TrackEvent[];
}

type Item = { at: string; kind: string; title: string; detail?: string; href?: string; noteId?: string };

// datetime-local wants local time without zone.
const toLocalInput = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function ApplicationView({ id }: { id: string }) {
  const { data, error, reload, setData } = useApi<Data>(`/api/applications/${id}`, 60_000);
  const [toast, setToast] = useState('');
  const [note, setNote] = useState('');
  const [form, setForm] = useState<Partial<Application> | null>(null);
  const [busy, setBusy] = useState<'' | 'brief' | 'prep'>('');
  const [newItem, setNewItem] = useState('');

  const app = data?.application;
  useEffect(() => {
    if (app && !form) setForm(app);
  }, [app, form]);

  const timeline = useMemo<Item[]>(() => {
    if (!data) return [];
    const items: Item[] = [];
    for (const h of data.application.stageHistory) items.push({ at: h.at, kind: 'stage', title: `Moved to ${STAGE_LABEL[h.stage]}` });
    for (const m of data.messages) {
      if (m.kind === 'link') items.push({ at: m.sentAt, kind: 'link', title: `Created tracked link · ${m.label}`, href: `#/m/${m._id}` });
      else if (m.status === 'scheduled')
        items.push({ at: m.scheduledAt ?? m.sentAt, kind: 'scheduled', title: `Scheduled: ${m.subject}`, href: `#/m/${m._id}` });
      else
        items.push({
          at: m.sentAt,
          kind: 'sent',
          title: `${m.followUpOf ? 'Followed up' : 'Emailed'} ${m.to.map((r) => r.name || r.email).join(', ')}`,
          detail: m.subject,
          href: `#/m/${m._id}`,
        });
    }
    for (const e of data.events) {
      const m = data.messages.find((x) => x._id === e.messageId);
      const label = e.linkToken ? m?.links.find((l) => l.token === e.linkToken)?.label : undefined;
      const place = [e.city, e.country].filter(Boolean).join(', ');
      if (e.type === 'reply')
        items.push({ at: e.at, kind: 'reply', title: `${(e.from ?? 'They').replace(/<[^>]+>/, '').replace(/"/g, '').trim()} replied`, detail: m?.subject, href: m && `#/m/${m._id}` });
      else
        items.push({
          at: e.at,
          kind: e.type,
          title: e.type === 'click' ? `Clicked ${label ?? 'a link'}` : 'Opened your email',
          detail: [place, m?.subject].filter(Boolean).join(' · '),
          href: m && `#/m/${m._id}`,
        });
    }
    for (const n of data.application.notes ?? []) items.push({ at: n.at, kind: 'note', title: n.text, noteId: n._id });
    return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [data]);

  if (error) return <p className="error">{error}</p>;
  if (!data || !app || !form) return <p className="muted page">Loading…</p>;

  const patch = async (body: Record<string, unknown>, msg?: string) => {
    const r = await api<{ application: Application }>(`/api/applications/${id}`, { method: 'PATCH', body });
    setData((d) => (d ? { ...d, application: { ...d.application, ...r.application } } : d));
    if (msg) setToast(msg);
  };

  const setStage = (stage: Stage) => patch({ stage }, `Moved to ${STAGE_LABEL[stage]}`).then(reload);

  const saveDetails = async () => {
    try {
      await patch(
        {
          company: form.company,
          role: form.role,
          jobUrl: form.jobUrl,
          location: form.location,
          salary: form.salary,
          source: form.source,
          jobDescription: form.jobDescription,
          contacts: form.contacts,
          interviewAt: form.interviewAt || null,
        },
        'Saved',
      );
    } catch (e) {
      setToast((e as Error).message);
    }
  };

  const addNote = async () => {
    if (!note.trim()) return;
    await api(`/api/applications/${id}/notes`, { method: 'POST', body: { text: note } });
    setNote('');
    reload();
  };

  const deleteNote = async (noteId: string) => {
    await api(`/api/applications/${id}/notes/${noteId}`, { method: 'DELETE' });
    reload();
  };

  const runAi = async (kind: 'brief' | 'prep') => {
    setBusy(kind);
    try {
      if (kind === 'brief') {
        const r = await api<{ brief: Application['brief'] }>(`/api/applications/${id}/brief`, { method: 'POST', body: {} });
        setData((d) => (d ? { ...d, application: { ...d.application, brief: r.brief } } : d));
      } else {
        const r = await api<{ prep: Application['prep'] }>(`/api/applications/${id}/prep/generate`, { method: 'POST', body: {} });
        setData((d) => (d ? { ...d, application: { ...d.application, prep: r.prep } } : d));
      }
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const savePrep = async (items: { text: string; done: boolean }[]) => {
    setData((d) => (d ? { ...d, application: { ...d.application, prep: items } } : d));
    await api(`/api/applications/${id}/prep`, { method: 'PUT', body: { items } });
  };

  const setContact = (i: number, c: Partial<Contact>) =>
    setForm({ ...form, contacts: (form.contacts ?? []).map((x, j) => (j === i ? { ...x, ...c } : x)) });

  const emails = data.messages.filter((m) => m.kind === 'email');
  const lastSent = [...emails].reverse().find((m) => m.status === 'sent' || !m.status);
  const prep = app.prep ?? [];
  const briefHtml = app.brief?.text ? renderBody(app.brief.text).html : '';

  return (
    <div className="page">
      <a href="#/pipeline" className="back muted">
        ← Pipeline
      </a>
      <header className="app-head">
        <Logo name={app.company} size={52} />
        <div className="app-title">
          <h1>{app.company}</h1>
          <div className="muted">
            {app.role || 'Role not set'}
            {app.location && ` · ${app.location}`}
            {app.jobUrl && (
              <>
                {' · '}
                <a href={app.jobUrl} target="_blank" rel="noreferrer">
                  Job posting <Icon name="external" size={12} />
                </a>
              </>
            )}
          </div>
        </div>
        <Stars value={app.priority} onChange={(p) => patch({ priority: p })} />
      </header>

      <div className="stepper" role="group" aria-label="Stage">
        {OPEN_STAGES.map((s, i) => {
          const rank = OPEN_STAGES.indexOf(app.stage as (typeof OPEN_STAGES)[number]);
          return (
            <button key={s} className={`step${s === app.stage ? ' current' : ''}${rank >= 0 && i < rank ? ' done' : ''}`} onClick={() => setStage(s)}>
              {STAGE_LABEL[s]}
            </button>
          );
        })}
        <select
          className={`close-select${(CLOSED_STAGES as readonly string[]).includes(app.stage) ? ' active' : ''}`}
          value={(CLOSED_STAGES as readonly string[]).includes(app.stage) ? app.stage : ''}
          onChange={(e) => e.target.value && setStage(e.target.value as Stage)}
          aria-label="Close as"
        >
          <option value="">Close as…</option>
          {CLOSED_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="action-row">
        <a className="button primary" href={`#/compose?app=${app._id}`}>
          <Icon name="pen" size={15} /> Write email
        </a>
        {lastSent && (
          <a className="button" href={`#/compose?followup=${lastSent._id}`}>
            <Icon name="reply" size={15} /> Follow up
          </a>
        )}
        <a className="button" href={`#/link?app=${app._id}`}>
          <Icon name="link" size={15} /> Tracked link
        </a>
        <button className="ghost" onClick={() => patch({ archived: !app.archived }, app.archived ? 'Restored' : 'Archived').then(() => !app.archived && go('/pipeline'))}>
          {app.archived ? 'Unarchive' : 'Archive'}
        </button>
      </div>

      <div className="columns detail-cols">
        <div className="col">
          <section className="card">
            <h2>Activity</h2>
            <div className="note-box">
              <textarea
                rows={2}
                placeholder="Add a note: who you talked to, what they said, next step…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && addNote()}
              />
              <button className="small" onClick={addNote} disabled={!note.trim()}>
                Add note
              </button>
            </div>
            <ol className="timeline">
              {timeline.map((t, i) => (
                <li key={i} className={`tl tl-${t.kind}`}>
                  <span className={`tl-dot tk-${t.kind}`} />
                  <div className="tl-main">
                    {t.href ? (
                      <a href={t.href} className="tl-title">
                        {t.title}
                      </a>
                    ) : (
                      <div className={t.kind === 'note' ? 'tl-note' : 'tl-title'}>{t.title}</div>
                    )}
                    <div className="muted small">
                      {when(t.at)} ({ago(t.at)}){t.detail ? ` · ${t.detail}` : ''}
                      {t.noteId && (
                        <>
                          {' · '}
                          <button className="link-btn small" onClick={() => deleteNote(t.noteId!)}>
                            delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {emails.length > 0 && (
            <section className="card">
              <h2>Emails</h2>
              <ul className="task-list">
                {emails.map((m) => {
                  const st = statusOf(m);
                  return (
                    <li key={m._id} className="task">
                      <span className={`pill ${st}`}>{STATUS_LABEL[st]}</span>
                      <div className="task-main">
                        <a href={`#/m/${m._id}`} className="task-title">
                          {m.subject}
                        </a>
                        <div className="muted small">
                          {m.status === 'scheduled' ? `sends ${ago(m.scheduledAt)}` : when(m.sentAt)} · {m.stats.opens} opens · {m.stats.clicks} clicks
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        <div className="col">
          <section className="card form">
            <h2>Details</h2>
            <div className="two">
              <label>
                Company
                <input value={form.company ?? ''} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              </label>
              <label>
                Role
                <input value={form.role ?? ''} onChange={(e) => setForm({ ...form, role: e.target.value })} />
              </label>
            </div>
            <label>
              Job link
              <input value={form.jobUrl ?? ''} onChange={(e) => setForm({ ...form, jobUrl: e.target.value })} placeholder="https://…" />
            </label>
            <div className="two">
              <label>
                Source
                <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as Source })}>
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Location
                <input value={form.location ?? ''} onChange={(e) => setForm({ ...form, location: e.target.value })} />
              </label>
            </div>
            <div className="two">
              <label>
                Salary / range
                <input value={form.salary ?? ''} onChange={(e) => setForm({ ...form, salary: e.target.value })} placeholder="₹30–40 LPA" />
              </label>
              <label>
                Next interview
                <input
                  type="datetime-local"
                  value={toLocalInput(form.interviewAt)}
                  onChange={(e) => setForm({ ...form, interviewAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
                />
              </label>
            </div>
            <div className="field-label">Contacts</div>
            {(form.contacts ?? []).map((c, i) => (
              <div key={i} className="contact-row">
                <input placeholder="Name" value={c.name} onChange={(e) => setContact(i, { name: e.target.value })} />
                <input placeholder="Email" value={c.email} onChange={(e) => setContact(i, { email: e.target.value })} />
                <input placeholder="Title" value={c.title} onChange={(e) => setContact(i, { title: e.target.value })} />
                <button className="icon-btn" aria-label="Remove contact" onClick={() => setForm({ ...form, contacts: (form.contacts ?? []).filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
            <button
              className="ghost small add-contact"
              onClick={() => setForm({ ...form, contacts: [...(form.contacts ?? []), { name: '', email: '', title: '', linkedin: '' }] })}
            >
              + Add contact
            </button>
            <label>
              Job description
              <textarea
                rows={5}
                value={form.jobDescription ?? ''}
                onChange={(e) => setForm({ ...form, jobDescription: e.target.value })}
                placeholder="Paste it here: Gemini uses it to tailor emails, research and prep."
              />
            </label>
            <div className="actions">
              <span className="muted small">{SOURCE_LABEL[app.source]} · added {ago(app.createdAt)}</span>
              <button className="primary" onClick={saveDetails}>
                Save details
              </button>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>
                <Icon name="spark" size={15} /> Company brief
              </h2>
              <button className="small" onClick={() => runAi('brief')} disabled={!!busy}>
                {busy === 'brief' ? 'Researching…' : app.brief?.text ? 'Refresh' : 'Research with Gemini'}
              </button>
            </div>
            {busy === 'brief' && <p className="muted small">Gemini is searching the web, about 20–40 seconds.</p>}
            {app.brief?.text ? (
              <>
                <div className="brief" dangerouslySetInnerHTML={{ __html: briefHtml }} />
                {(app.brief.sources?.length ?? 0) > 0 && (
                  <div className="sources small">
                    Sources:{' '}
                    {app.brief.sources!.map((s, i) => (
                      <a key={i} href={s.url} target="_blank" rel="noreferrer">
                        {s.title || `source ${i + 1}`}
                      </a>
                    ))}
                  </div>
                )}
                <div className="muted small">Researched {ago(app.brief.at)}. Check facts before quoting them.</div>
              </>
            ) : (
              !busy && <p className="muted small">What they do, funding, recent news and angles to mention in outreach.</p>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>
                <Icon name="check" size={15} /> Interview prep
              </h2>
              <button className="small" onClick={() => runAi('prep')} disabled={!!busy}>
                {busy === 'prep' ? 'Thinking…' : prep.length ? 'Add more' : 'Generate checklist'}
              </button>
            </div>
            {prep.length > 0 && (
              <div className="progress small muted">
                {prep.filter((p) => p.done).length}/{prep.length} done
                <span className="bar">
                  <i style={{ width: `${(prep.filter((p) => p.done).length / prep.length) * 100}%` }} />
                </span>
              </div>
            )}
            <ul className="checklist">
              {prep.map((p, i) => (
                <li key={i} className={p.done ? 'done' : ''}>
                  <label>
                    <input type="checkbox" checked={p.done} onChange={() => savePrep(prep.map((x, j) => (j === i ? { text: x.text, done: !x.done } : { text: x.text, done: x.done })))} />
                    <span>{p.text}</span>
                  </label>
                  <button className="icon-btn" aria-label="Remove" onClick={() => savePrep(prep.filter((_, j) => j !== i).map((x) => ({ text: x.text, done: x.done })))}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <div className="inline-add">
              <input
                placeholder="Add your own item"
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newItem.trim()) {
                    void savePrep([...prep.map((x) => ({ text: x.text, done: x.done })), { text: newItem.trim(), done: false }]);
                    setNewItem('');
                  }
                }}
              />
            </div>
          </section>
          <div className="muted small stage-now">
            Currently <StageBadge stage={app.stage} /> since {ago(app.stageHistory.at(-1)?.at ?? app.createdAt)}
          </div>
        </div>
      </div>
      {toast && <Toast text={toast} onDone={() => setToast('')} />}
    </div>
  );
}
