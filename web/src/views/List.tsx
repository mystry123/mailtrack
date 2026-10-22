import { useEffect, useMemo, useState } from 'react';
import { api, type Message } from '../api';
import { Empty, Logo } from '../components';
import { ago, recipients, STATUS_LABEL, statusOf } from '../format';
import { Icon } from '../icons';
import { go } from '../nav';

const FILTERS = [
  ['all', 'All'],
  ['replied', 'Replied'],
  ['clicked', 'Clicked'],
  ['opened', 'Opened, no click'],
  ['quiet', 'No activity'],
  ['scheduled', 'Scheduled'],
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
    const emails = (messages ?? []).filter((m) => m.kind === 'email' && (m.status ?? 'sent') === 'sent');
    const pct = (n: number) => (emails.length ? `${Math.round((n / emails.length) * 100)}%` : '');
    const opened = emails.filter((m) => m.stats.opens > 0).length;
    const clicked = emails.filter((m) => m.stats.clicks > 0).length;
    const replied = emails.filter((m) => (m.stats.replies ?? 0) > 0).length;
    return { sent: emails.length, opened, clicked, replied, pct };
  }, [messages]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Sent</h1>
          <p className="muted">Every tracked email and link, newest first.</p>
        </div>
        <a className="button primary" href="#/compose">
          <Icon name="pen" size={15} /> New email
        </a>
      </header>

      <div className="kpis four">
        <div className="kpi">
          <div className="kpi-n">{totals.sent}</div>
          <div className="kpi-l">Emails{filter !== 'all' || q ? ' (filtered)' : ''}</div>
        </div>
        <div className="kpi">
          <div className="kpi-n">
            {totals.opened}
            <span className="kpi-pct">{totals.pct(totals.opened)}</span>
          </div>
          <div className="kpi-l">Opened</div>
        </div>
        <div className="kpi">
          <div className="kpi-n">
            {totals.clicked}
            <span className="kpi-pct">{totals.pct(totals.clicked)}</span>
          </div>
          <div className="kpi-l">Clicked a link</div>
        </div>
        <div className="kpi">
          <div className="kpi-n">
            {totals.replied}
            <span className="kpi-pct">{totals.pct(totals.replied)}</span>
          </div>
          <div className="kpi-l">Replied</div>
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
        <div className="search-box">
          <Icon name="search" size={15} />
          <input placeholder="Search name, email, company, subject" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      {messages === null ? (
        <p className="muted">Loading…</p>
      ) : messages.length === 0 ? (
        <div className="card">
          <Empty icon="✉" title="Nothing here yet">
            <a className="button primary" href="#/compose">
              Write an email
            </a>
          </Empty>
        </div>
      ) : (
        <div className="card rows">
          {messages.map((m) => {
            const status = statusOf(m);
            const who = recipients(m);
            return (
              <button key={m._id} className="row" onClick={() => go(`/m/${m._id}`)}>
                <Logo name={m.label || who} size={30} />
                <span className="row-main">
                  <span className="row-who">
                    {who}
                    {m.kind === 'email' && m.label && <span className="tag">{m.label}</span>}
                    {m.kind === 'link' && <span className="tag">link</span>}
                    {m.followUpOf && <span className="tag">{m.automatic ? 'auto follow-up' : 'follow-up'}</span>}
                    {m.sequence?.status === 'active' && <span className="tag">follow-ups on</span>}
                  </span>
                  <span className="row-sub muted">{m.kind === 'email' ? m.subject : m.links[0]?.url}</span>
                </span>
                <span className="row-counts">
                  {m.kind === 'email' && <span title="Opens">◉ {m.stats.opens}</span>}
                  <span title="Clicks">↗ {m.stats.clicks}</span>
                  {m.kind === 'email' && <span title="Replies">↩ {m.stats.replies ?? 0}</span>}
                </span>
                <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>
                <span className="row-time muted" title={new Date(m.sentAt).toLocaleString()}>
                  {m.status === 'scheduled'
                    ? `sends ${ago(m.scheduledAt)}`
                    : m.stats.lastActivityAt
                      ? `active ${ago(m.stats.lastActivityAt)}`
                      : `sent ${ago(m.sentAt)}`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
