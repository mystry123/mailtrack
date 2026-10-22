import { useEffect, useMemo, useState } from 'react';
import { api, type Message } from '../api';
import { go } from '../nav';
import { ago, recipients, STATUS_LABEL, statusOf } from '../format';

const FILTERS = [
  ['all', 'All'],
  ['clicked', 'Clicked'],
  ['opened', 'Opened, no click'],
  ['quiet', 'No activity'],
  ['links', 'Tracked links'],
] as const;

export function List() {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => {
      const params = new URLSearchParams({ filter, q, archived: archived ? '1' : '0' });
      api<{ messages: Message[] }>(`/api/messages?${params}`)
        .then((r) => alive && (setMessages(r.messages), setError('')))
        .catch((e) => alive && setError(e.message));
    };
    const t0 = setTimeout(load, q ? 250 : 0);
    // Opens and clicks arrive in the background; keep the list fresh.
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [filter, q, archived]);

  const totals = useMemo(() => {
    const list = messages ?? [];
    const emails = list.filter((m) => m.kind === 'email');
    return {
      sent: emails.length,
      opened: emails.filter((m) => m.stats.opens > 0).length,
      clicked: list.filter((m) => m.stats.clicks > 0).length,
    };
  }, [messages]);

  return (
    <section>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi-n">{totals.sent}</div>
          <div className="kpi-l">Emails{filter !== 'all' || q ? ' (filtered)' : ''}</div>
        </div>
        <div className="kpi">
          <div className="kpi-n">
            {totals.opened}
            {totals.sent > 0 && <span className="kpi-pct">{Math.round((totals.opened / totals.sent) * 100)}%</span>}
          </div>
          <div className="kpi-l">Opened</div>
        </div>
        <div className="kpi">
          <div className="kpi-n">{totals.clicked}</div>
          <div className="kpi-l">Clicked a link</div>
        </div>
      </div>

      <div className="toolbar">
        <div className="chips">
          {FILTERS.map(([key, label]) => (
            <button key={key} className={filter === key ? 'chip on' : 'chip'} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <input className="search" placeholder="Search name, email, company, subject" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      {messages === null ? (
        <p className="muted pad">Loading…</p>
      ) : messages.length === 0 ? (
        <div className="empty card">
          <p>Nothing here yet.</p>
          <a className="button primary" href="#/compose">
            Write an email
          </a>
        </div>
      ) : (
        <div className="card rows">
          {messages.map((m) => {
            const status = statusOf(m);
            return (
              <button key={m._id} className="row" onClick={() => go(`/m/${m._id}`)}>
                <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>
                <span className="row-main">
                  <span className="row-who">
                    {recipients(m)}
                    {m.kind === 'email' && m.label && <span className="tag">{m.label}</span>}
                    {m.kind === 'link' && <span className="tag">link</span>}
                  </span>
                  <span className="row-sub muted">{m.kind === 'email' ? m.subject : m.links[0]?.url}</span>
                </span>
                <span className="row-counts">
                  <span title="Opens">{m.kind === 'email' ? `${m.stats.opens} opens` : ''}</span>
                  <span title="Clicks">{m.stats.clicks} clicks</span>
                </span>
                <span className="row-time muted" title={new Date(m.sentAt).toLocaleString()}>
                  {m.stats.lastActivityAt ? `active ${ago(m.stats.lastActivityAt)}` : `sent ${ago(m.sentAt)}`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
