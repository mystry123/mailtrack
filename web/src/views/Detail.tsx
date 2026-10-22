import { useEffect, useState } from 'react';
import { api, type Application, type Message, type Signal, type TrackEvent } from '../api';
import { AppPicker, Logo, StageBadge, Toast, useApi, type PickedApp } from '../components';
import { ago, place, SIGNAL_LABEL, SOURCE_LABEL, STATUS_LABEL, statusOf, when } from '../format';
import { Icon } from '../icons';
import { go } from '../nav';
import { CopyButton } from './CopyButton';

interface Data {
  message: Message;
  events: TrackEvent[];
  application: Pick<Application, '_id' | 'company' | 'role' | 'stage'> | null;
  thread: Pick<Message, '_id' | 'subject' | 'sentAt' | 'stats' | 'status' | 'followUpOf'>[];
}

// For emails sent before they belonged to a company (or sent without one).
function LinkToCompany({ message, onLinked }: { message: Message; onLinked: (company: string) => void }) {
  const [apps, setApps] = useState<Application[]>([]);
  const [pick, setPick] = useState<PickedApp & { label?: string }>(() =>
    message.label ? { newApplication: { company: message.label, role: '' }, label: message.label } : {},
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ applications: Application[] }>('/api/applications')
      .then((r) => {
        setApps(r.applications);
        const hit = r.applications.find((a) => a.company.toLowerCase() === message.label.toLowerCase());
        if (hit) setPick({ applicationId: hit._id, label: hit.company });
      })
      .catch(() => undefined);
  }, [message.label]);

  const link = async () => {
    setBusy(true);
    try {
      let applicationId = pick.applicationId;
      if (!applicationId && pick.newApplication) {
        const stage = (message.stats.replies ?? 0) > 0 ? 'replied' : 'reached_out';
        const r = await api<{ application: Application }>('/api/applications', { method: 'POST', body: { ...pick.newApplication, stage } });
        applicationId = r.application._id;
      }
      if (!applicationId) return;
      await api(`/api/messages/${message._id}`, { method: 'PATCH', body: { applicationId } });
      onLinked(pick.label ?? 'company');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Add to pipeline</h2>
      <p className="small muted">Link this email to a company so it shows on the board and in follow-up reminders.</p>
      <AppPicker value={pick} apps={apps} onChange={setPick} />
      <div className="actions" style={{ marginTop: 10 }}>
        <button className="primary small" disabled={busy || (!pick.applicationId && !pick.newApplication)} onClick={link}>
          Link
        </button>
      </div>
    </section>
  );
}

export function Detail({ id }: { id: string }) {
  const { data, error, reload } = useApi<Data>(`/api/messages/${id}`, 15_000);
  const [showAll, setShowAll] = useState(false);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  if (error) return <p className="error page">{error}</p>;
  if (!data) return <p className="muted page">Loading…</p>;

  const { message: m, events, application, thread } = data;
  const status = statusOf(m);
  const counted = events.filter((e) => e.signal === 'real');
  const shown = showAll ? events : counted;
  const hidden = events.length - counted.length;
  const linkLabel = (token?: string) => m.links.find((l) => l.token === token)?.label || 'a link';
  const isEmail = m.kind === 'email';
  const pending = m.status === 'scheduled' || m.status === 'failed';

  const setSignal = async (e: TrackEvent, signal: Signal) => {
    await api(`/api/events/${e._id}`, { method: 'PATCH', body: { signal } });
    reload();
  };

  const archive = async () => {
    await api(`/api/messages/${m._id}`, { method: 'PATCH', body: { archived: !m.archived } });
    if (!m.archived) go('/sent');
    else reload();
  };

  const act = async (path: 'cancel' | 'send-now') => {
    setBusy(true);
    try {
      await api(`/api/messages/${m._id}/${path}`, { method: 'POST', body: {} });
      setToast(path === 'cancel' ? 'Cancelled' : 'Sent');
      reload();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <a href="#/sent" className="back muted">
        ← Sent
      </a>

      <header className="detail-head">
        <div>
          <h1>{isEmail ? m.subject : m.label}</h1>
          <p className="muted">
            {isEmail ? (
              <>
                To {m.to.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(', ')}
                {m.cc.length > 0 && <> · Cc {m.cc.map((r) => r.email).join(', ')}</>}
              </>
            ) : (
              'Tracked link'
            )}{' '}
            · {m.status === 'scheduled' ? `sends ${when(m.scheduledAt ?? m.sentAt)} (${ago(m.scheduledAt)})` : `${isEmail ? 'sent' : 'created'} ${when(m.sentAt)}`}
          </p>
          {application && (
            <a href={`#/a/${application._id}`} className="app-chip">
              <Logo name={application.company} size={20} /> {application.company}
              {application.role && <span className="muted"> · {application.role}</span>} <StageBadge stage={application.stage} />
            </a>
          )}
        </div>
        <div className="head-actions">
          <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>
          {isEmail && !pending && (
            <>
              <a className="button small" href={`#/compose?followup=${m._id}`}>
                <Icon name="reply" size={14} /> Follow up
              </a>
              <a className="button small" href={`#/compose?again=${m._id}`} title="Same subject and message, to the same or new people">
                Send again
              </a>
            </>
          )}
          <button className="ghost small" onClick={archive}>
            {m.archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      </header>

      {pending && (
        <div className={m.status === 'failed' ? 'banner warn' : 'banner'}>
          {m.status === 'failed' ? <>Not sent: {m.sendError}</> : <>Scheduled. You can still cancel it or send it right now.</>}
          <span className="banner-actions">
            <button className="small" disabled={busy} onClick={() => act('send-now')}>
              Send now
            </button>
            <button className="ghost small" disabled={busy} onClick={() => act('cancel')}>
              Cancel
            </button>
          </span>
        </div>
      )}

      <div className="kpis">
        {isEmail && (
          <div className="kpi">
            <div className="kpi-n">{m.stats.opens}</div>
            <div className="kpi-l">Opens{m.stats.firstOpenAt ? ` · first ${ago(m.stats.firstOpenAt)}` : ''}</div>
          </div>
        )}
        <div className="kpi">
          <div className="kpi-n">{m.stats.clicks}</div>
          <div className="kpi-l">Clicks{m.stats.firstClickAt ? ` · first ${ago(m.stats.firstClickAt)}` : ''}</div>
        </div>
        {isEmail ? (
          <div className="kpi">
            <div className="kpi-n">{m.stats.replies ?? 0}</div>
            <div className="kpi-l">Replies{m.stats.firstReplyAt ? ` · first ${ago(m.stats.firstReplyAt)}` : ''}</div>
          </div>
        ) : (
          <div className="kpi">
            <div className="kpi-n">{m.stats.botClicks}</div>
            <div className="kpi-l">Ignored (bots, previews)</div>
          </div>
        )}
      </div>

      <div className="columns detail-cols">
        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2>Activity</h2>
              {hidden > 0 && (
                <button className="ghost small" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Hide ignored' : `Show ${hidden} ignored`}
                </button>
              )}
            </div>
            {shown.length === 0 ? (
              <p className="muted">{pending ? 'Nothing yet: it hasn’t been sent.' : `No ${showAll ? '' : 'counted '}activity yet.`}</p>
            ) : (
              <ol className="events">
                {shown.map((e) => (
                  <li key={e._id} className={e.signal === 'real' ? '' : 'dim'}>
                    <span className={`ev ${e.type}`}>{e.type === 'click' ? '↗' : e.type === 'reply' ? '↩' : '◉'}</span>
                    <div className="ev-main">
                      <div>
                        {e.type === 'click' ? (
                          <>
                            Clicked <strong>{linkLabel(e.linkToken)}</strong>
                          </>
                        ) : e.type === 'reply' ? (
                          <>
                            <strong>{(e.from ?? 'They').replace(/<[^>]+>/, '').replace(/"/g, '').trim()}</strong> replied
                          </>
                        ) : (
                          'Opened'
                        )}
                        {place(e) && <span className="muted"> · {place(e)}</span>}
                        {e.type !== 'reply' && <span className="muted"> · {SOURCE_LABEL[e.source] ?? e.source}</span>}
                      </div>
                      <div className="small muted" title={e.ua}>
                        {when(e.at)} ({ago(e.at)})
                        {e.signal !== 'real' && (
                          <>
                            {' '}
                            · <span className="tag">{SIGNAL_LABEL[e.signal]}</span> {e.manual ? 'marked by you' : e.reason}
                          </>
                        )}
                      </div>
                    </div>
                    {e.type !== 'reply' &&
                      (e.signal === 'real' ? (
                        <button className="ghost small" onClick={() => setSignal(e, 'self')}>
                          That was me
                        </button>
                      ) : (
                        <button className="ghost small" onClick={() => setSignal(e, 'real')}>
                          Count it
                        </button>
                      ))}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {isEmail && m.html && (
            <section className="card">
              <h2>Email</h2>
              {/* Sandboxed, scripts off; stored HTML has no pixel, so this never counts as an open. */}
              <iframe className="preview" sandbox="allow-popups" srcDoc={m.html.replace(/<a /g, '<a target="_blank" ')} title="Email" />
            </section>
          )}
        </div>

        <div className="col">
          {m.links.length > 0 && (
            <section className="card">
              <h2>Links</h2>
              {m.links.map((l) => (
                <div key={l.token} className="link-row">
                  <div className="link-main">
                    <strong>{l.label}</strong>
                    <a className="muted small" href={l.url} target="_blank" rel="noreferrer">
                      {l.url}
                    </a>
                  </div>
                  <span className={l.clicks > 0 ? 'count hot' : 'count'}>{l.clicks}</span>
                  {!isEmail && <CopyButton text={`${window.location.origin}/l/${l.token}`} label="Copy" />}
                </div>
              ))}
            </section>
          )}

          {!application && m.status !== 'cancelled' && (
            <LinkToCompany
              message={m}
              onLinked={(c) => {
                setToast(`Linked to ${c}`);
                reload();
              }}
            />
          )}

          {thread.length > 0 && (
            <section className="card">
              <h2>Thread</h2>
              <ul className="task-list">
                {thread.map((t) => {
                  const st = statusOf(t as Message);
                  return (
                    <li key={t._id} className="task">
                      <span className={`pill ${st}`}>{STATUS_LABEL[st]}</span>
                      <div className="task-main">
                        <a href={`#/m/${t._id}`} className="task-title">
                          {t.followUpOf ? 'Follow-up' : t.subject}
                        </a>
                        <div className="muted small">{when(t.sentAt)}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {isEmail && !pending && (m.stats.replies ?? 0) === 0 && (
            <section className="card tip">
              <h2>
                <Icon name="spark" size={14} /> Next step
              </h2>
              <p className="small">
                {m.stats.clicks > 0
                  ? 'They clicked a link but haven’t replied. A short, specific follow-up now has the best odds.'
                  : m.stats.opens > 0
                    ? 'Opened, no reply yet. Give it a few working days, then follow up in the same thread.'
                    : 'Not opened yet. Their inbox might be busy, or images are off. Try a follow-up in 4–5 working days, ideally on a weekday morning.'}
              </p>
              <a className="button small" href={`#/compose?followup=${m._id}`}>
                Draft a follow-up
              </a>
            </section>
          )}
        </div>
      </div>
      {toast && <Toast text={toast} onDone={() => setToast('')} />}
    </div>
  );
}
