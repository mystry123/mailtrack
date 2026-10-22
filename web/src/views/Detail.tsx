import { useCallback, useEffect, useState } from 'react';
import { api, type Message, type Signal, type TrackEvent } from '../api';
import { ago, place, SIGNAL_LABEL, SOURCE_LABEL, STATUS_LABEL, statusOf, when } from '../format';
import { go } from '../nav';
import { CopyButton } from './CopyButton';

export function Detail({ id }: { id: string }) {
  const [data, setData] = useState<{ message: Message; events: TrackEvent[] } | null>(null);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    api<{ message: Message; events: TrackEvent[] }>(`/api/messages/${id}`)
      .then((d) => (setData(d), setError('')))
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted pad">Loading…</p>;

  const { message: m, events } = data;
  const status = statusOf(m);
  const shown = showAll ? events : events.filter((e) => e.signal === 'real');
  const hidden = events.length - events.filter((e) => e.signal === 'real').length;
  const linkLabel = (token?: string) => m.links.find((l) => l.token === token)?.label || 'a link';

  const setSignal = async (e: TrackEvent, signal: Signal) => {
    await api(`/api/events/${e._id}`, { method: 'PATCH', body: { signal } });
    load();
  };

  const archive = async () => {
    await api(`/api/messages/${m._id}`, { method: 'PATCH', body: { archived: !m.archived } });
    if (!m.archived) go('/');
    else load();
  };

  return (
    <section className="detail">
      <a href="#/" className="back muted">
        ← All sent
      </a>

      <div className="detail-head">
        <div>
          <h1>{m.kind === 'email' ? m.subject : m.label}</h1>
          <p className="muted">
            {m.kind === 'email' ? (
              <>
                To {m.to.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(', ')}
                {m.cc.length > 0 && <> · Cc {m.cc.map((r) => r.email).join(', ')}</>}
                {m.label && <> · {m.label}</>}
              </>
            ) : (
              'Tracked link'
            )}{' '}
            · {m.kind === 'email' ? 'sent' : 'created'} {when(m.sentAt)}
          </p>
        </div>
        <div className="head-actions">
          <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>
          <button className="ghost" onClick={archive}>
            {m.archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      </div>

      <div className="kpis">
        {m.kind === 'email' && (
          <div className="kpi">
            <div className="kpi-n">{m.stats.opens}</div>
            <div className="kpi-l">Opens{m.stats.firstOpenAt ? ` · first ${ago(m.stats.firstOpenAt)}` : ''}</div>
          </div>
        )}
        <div className="kpi">
          <div className="kpi-n">{m.stats.clicks}</div>
          <div className="kpi-l">Clicks{m.stats.firstClickAt ? ` · first ${ago(m.stats.firstClickAt)}` : ''}</div>
        </div>
        <div className="kpi">
          <div className="kpi-n">{m.stats.autoOpens + m.stats.botClicks}</div>
          <div className="kpi-l">Ignored (proxies, scanners)</div>
        </div>
      </div>

      {m.links.length > 0 && (
        <div className="card">
          <h2>Links</h2>
          {m.links.map((l) => (
            <div key={l.token} className="link-row">
              <div className="link-main">
                <strong>{l.label}</strong>
                <a className="muted small" href={l.url} target="_blank" rel="noreferrer">
                  {l.url}
                </a>
              </div>
              <span className={l.clicks > 0 ? 'count hot' : 'count'}>{l.clicks} clicks</span>
              {m.kind === 'link' && <CopyButton text={`${window.location.origin}/l/${l.token}`} label="Copy tracked link" />}
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Activity</h2>
          {hidden > 0 && (
            <button className="ghost small" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Hide ignored' : `Show ${hidden} ignored`}
            </button>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="muted">No {showAll ? '' : 'counted '}activity yet.</p>
        ) : (
          <ol className="timeline">
            {shown.map((e) => (
              <li key={e._id} className={e.signal === 'real' ? '' : 'dim'}>
                <span className={`ev ${e.type}`}>{e.type === 'click' ? '↗' : '◉'}</span>
                <div className="ev-main">
                  <div>
                    {e.type === 'click' ? <>Clicked <strong>{linkLabel(e.linkToken)}</strong></> : 'Opened'}
                    {place(e) && <span className="muted"> · {place(e)}</span>}
                    <span className="muted"> · {SOURCE_LABEL[e.source] ?? e.source}</span>
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
                {e.signal === 'real' ? (
                  <button className="ghost small" onClick={() => setSignal(e, 'self')}>
                    That was me
                  </button>
                ) : (
                  <button className="ghost small" onClick={() => setSignal(e, 'real')}>
                    Count it
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {m.kind === 'email' && m.html && (
        <div className="card">
          <h2>Email</h2>
          {/* Sandboxed, scripts off; stored HTML has no pixel, so this never counts as an open. */}
          <iframe className="preview" sandbox="allow-popups" srcDoc={m.html.replace(/<a /g, '<a target="_blank" ')} title="Email" />
        </div>
      )}
    </section>
  );
}
