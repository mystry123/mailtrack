import { useMemo, useState, type ReactNode } from 'react';
import { OPEN_STAGES, STAGE_LABEL } from '../../../src/shared/stages';
import { api, type Me, type Today } from '../api';
import { Empty, ImportBanner, Logo, Toast, useApi } from '../components';
import { ago, day, linkName, streak, when, weekStart } from '../format';
import { Icon } from '../icons';
import { AddJob } from './Board';

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const who = (from?: string) => (from ?? '').replace(/<[^>]+>/, '').replace(/"/g, '').trim() || 'Someone';

interface Action {
  key: string;
  // Lower sorts first: what deserves attention most.
  rank: number;
  at: number;
  kind: 'reply' | 'interview' | 'click' | 'open' | 'followup' | 'ghost' | 'failed';
  company: string;
  title: ReactNode;
  sub: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
}

const KIND_LABEL: Record<Action['kind'], string> = {
  reply: 'Reply',
  interview: 'Interview',
  click: 'Clicked',
  open: 'Opened',
  followup: 'Follow up',
  ghost: 'Quiet',
  failed: 'Not sent',
};

export function TodayView({ me }: { me: Me }) {
  const { data, error, reload } = useApi<Today>('/api/today', 60_000);
  const [toast, setToast] = useState('');
  const [adding, setAdding] = useState(false);

  const week = useMemo(() => {
    const start = weekStart().getTime();
    const started = data?.started ?? [];
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start + i * 86_400_000);
      return { d, n: started.filter((s) => new Date(s).toDateString() === d.toDateString()).length };
    });
    return { done: started.filter((s) => new Date(s).getTime() >= start).length, days, streak: streak(started) };
  }, [data]);

  const patchApp = async (id: string, body: Record<string, unknown>, msg: string) => {
    await api(`/api/applications/${id}`, { method: 'PATCH', body });
    setToast(msg);
    reload();
  };

  const snooze = (id: string, days: number) =>
    patchApp(id, { snoozedUntil: new Date(Date.now() + days * 86_400_000).toISOString() }, `Hidden for ${days} days`);

  const actions = useMemo<Action[]>(() => {
    if (!data) return [];
    const out: Action[] = [];
    for (const r of data.replies) {
      if (!r.message) continue;
      out.push({
        key: `r${r.message._id}${r.at}`,
        rank: 0,
        at: +new Date(r.at),
        kind: 'reply',
        company: r.application?.company || who(r.from),
        title: (
          <>
            {who(r.from)} replied{r.application ? <span className="muted"> · {r.application.company}</span> : null}
          </>
        ),
        sub: `${ago(r.at)} · ${r.message.subject}`,
        primary: (
          <a className="button small primary" href={r.application ? `#/a/${r.application._id}` : `#/m/${r.message._id}`}>
            Open
          </a>
        ),
      });
    }
    for (const a of data.interviews) {
      out.push({
        key: `i${a._id}`,
        rank: 1,
        at: +new Date(a.interviewAt!),
        kind: 'interview',
        company: a.company,
        title: <>Interview with {a.company}</>,
        sub: `${when(a.interviewAt!)} · ${a.role || 'role not set'}`,
        primary: (
          <a className="button small primary" href={`#/a/${a._id}`}>
            Prepare
          </a>
        ),
      });
    }
    for (const h of data.hot) {
      const name = h.application?.company || h.message.label || h.message.to[0]?.name || h.message.to[0]?.email || 'Someone';
      const clicked = h.clicks > 0;
      out.push({
        key: `h${h.message._id}`,
        rank: clicked ? 2 : 4,
        at: +new Date(h.lastAt),
        kind: clicked ? 'click' : 'open',
        company: name,
        title: clicked ? (
          <>
            {name} clicked <strong>{h.clickedLabels.map(linkName).join(', ')}</strong>
          </>
        ) : (
          <>
            {name} read your email{h.opens > 1 ? ` ${h.opens}×` : ''}
          </>
        ),
        sub: `${ago(h.lastAt)} · ${h.message.kind === 'link' ? 'tracked link' : h.message.subject}`,
        primary:
          h.message.kind === 'link' ? (
            <a className="button small" href={`#/m/${h.message._id}`}>
              View
            </a>
          ) : (
            <a className="button small primary" href={`#/compose?followup=${h.message._id}`} title="They're thinking about you right now">
              Follow up
            </a>
          ),
      });
    }
    for (const f of data.followUps) {
      out.push({
        key: `f${f.message._id}`,
        rank: 3,
        at: +new Date(f.message.sentAt),
        kind: 'followup',
        company: f.application.company,
        title: (
          <>
            {f.followUpNumber === 1 ? 'Follow up with' : 'Last nudge to'} {f.application.company}
          </>
        ),
        sub: `No reply in ${f.daysSince} days${f.message.stats.opens > 0 ? ` · opened ${f.message.stats.opens}×` : ''}`,
        primary: (
          <a className="button small primary" href={`#/compose?followup=${f.message._id}`}>
            Write follow-up
          </a>
        ),
        secondary: (
          <button className="button small ghost" onClick={() => snooze(f.application._id, 3)}>
            Later
          </button>
        ),
      });
    }
    for (const g of data.ghosted) {
      out.push({
        key: `g${g.application._id}`,
        rank: 5,
        at: 0,
        kind: 'ghost',
        company: g.application.company,
        title: <>{g.application.company} went quiet</>,
        sub: `Two follow-ups, nothing for ${g.daysSince} days`,
        primary: (
          <button className="button small" onClick={() => patchApp(g.application._id, { stage: 'ghosted' }, `${g.application.company} marked ghosted`)}>
            Mark ghosted
          </button>
        ),
        secondary: (
          <button className="button small ghost" onClick={() => snooze(g.application._id, 14)}>
            Keep
          </button>
        ),
      });
    }
    for (const s of data.scheduled.filter((x) => x.status === 'failed')) {
      out.push({
        key: `x${s._id}`,
        rank: 1,
        at: 0,
        kind: 'failed',
        company: s.label || s.to[0]?.email || '?',
        title: <>Scheduled email didn't send</>,
        sub: `${s.subject} · ${s.sendError ?? ''}`,
        primary: (
          <a className="button small primary" href={`#/m/${s._id}`}>
            Fix
          </a>
        ),
      });
    }
    return out.sort((a, b) => a.rank - b.rank || b.at - a.at);
  }, [data]);

  const goal = data?.goal ?? me.weeklyGoal;
  const waiting = data ? (data.stageCounts.reached_out ?? 0) + (data.stageCounts.applied ?? 0) : 0;
  const maxStage = Math.max(1, ...OPEN_STAGES.map((s) => data?.stageCounts[s] ?? 0));
  const first = (me.fromName || me.name).split(' ')[0];
  const scheduled = data?.scheduled.filter((s) => s.status === 'scheduled') ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>
            {greeting()}
            {first ? `, ${first}` : ''}
          </h1>
          <p className="muted">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            {actions.length > 0 ? ` · ${actions.length} thing${actions.length === 1 ? '' : 's'} to do` : ''}
          </p>
        </div>
        <div className="head-actions">
          <button className="button" onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} /> Add job
          </button>
          <a className="button primary" href="#/compose">
            <Icon name="pen" size={15} /> New email
          </a>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      <ImportBanner
        onDone={(m) => {
          setToast(m);
          reload();
        }}
      />

      <div className="stats">
        <div className="stat">
          <div className="stat-label">This week</div>
          <div className="stat-value">
            {week.done}
            <span className="stat-of"> / {goal}</span>
          </div>
          <div className="meter" aria-hidden>
            <i style={{ width: `${goal ? Math.min(100, (week.done / goal) * 100) : 0}%` }} />
          </div>
          <div className="stat-foot">
            {goal && week.done >= goal ? 'Goal reached' : `${Math.max(0, goal - week.done)} to go`}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Streak</div>
          <div className="stat-value">
            {week.streak}
            <span className="stat-of"> day{week.streak === 1 ? '' : 's'}</span>
          </div>
          <div className="week-strip" aria-label="Applications started each day this week">
            {week.days.map(({ d, n }) => (
              <span key={d.toISOString()} className={`wday${n ? ' on' : ''}${d.toDateString() === new Date().toDateString() ? ' today' : ''}`} title={`${d.toLocaleDateString(undefined, { weekday: 'long' })}: ${n}`}>
                {d.toLocaleDateString(undefined, { weekday: 'narrow' })}
              </span>
            ))}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Waiting to hear back</div>
          <div className="stat-value">{waiting}</div>
          <div className="stat-foot">applied or reached out</div>
        </div>
        <div className="stat">
          <div className="stat-label">In conversation</div>
          <div className="stat-value">
            {(data?.stageCounts.replied ?? 0) + (data?.stageCounts.screening ?? 0) + (data?.stageCounts.interviewing ?? 0)}
          </div>
          <div className="stat-foot">{(data?.stageCounts.offer ?? 0) > 0 ? `${data!.stageCounts.offer} offer${data!.stageCounts.offer === 1 ? '' : 's'}` : 'replied, screening or interviewing'}</div>
        </div>
      </div>

      <div className="today-cols">
        <section className="panel">
          <div className="panel-head">
            <h2>Up next</h2>
            {actions.length > 0 && <span className="muted small">Most important first</span>}
          </div>
          {!data ? (
            <div className="skeleton-list">
              <i />
              <i />
              <i />
            </div>
          ) : actions.length === 0 ? (
            <Empty icon="✓" title="You're all caught up">
              Replies, hot leads and follow-ups land here. Follow-ups come due {me.followUpDays} working days after an email gets no reply.
              <div className="empty-actions">
                <a className="button primary small" href="#/compose">
                  Send an email
                </a>
                <button className="button small" onClick={() => setAdding(true)}>
                  Add a job
                </button>
              </div>
            </Empty>
          ) : (
            <ul className="actions-list">
              {actions.map((a, i) => (
                <li key={a.key} className={i === 0 ? 'action first' : 'action'}>
                  <Logo name={a.company} size={36} />
                  <div className="action-main">
                    <div className="action-title">
                      <span className={`kind kind-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                      <span className="action-text">{a.title}</span>
                    </div>
                    <div className="action-sub">{a.sub}</div>
                  </div>
                  <div className="action-buttons">
                    {a.secondary}
                    {a.primary}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="side">
          <section className="panel">
            <div className="panel-head">
              <h2>Pipeline</h2>
              <a href="#/pipeline" className="small">
                Open board →
              </a>
            </div>
            <ul className="stage-bars">
              {OPEN_STAGES.map((s) => {
                const n = data?.stageCounts[s] ?? 0;
                return (
                  <li key={s}>
                    <a href="#/pipeline">
                      <span className="sb-label">{STAGE_LABEL[s]}</span>
                      <span className="sb-track">
                        <i className={`sb-fill stage-fill-${s}`} style={{ width: `${(n / maxStage) * 100}%` }} />
                      </span>
                      <span className="sb-n">{n}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>

          {scheduled.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2>Scheduled</h2>
              </div>
              <ul className="mini-list">
                {scheduled.map((s) => (
                  <li key={s._id}>
                    <a href={`#/m/${s._id}`}>{s.subject}</a>
                    <span className="muted small">
                      {s.scheduledAt && `${day(s.scheduledAt)}, ${new Date(s.scheduledAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!me.replyDetection && (
            <section className="panel hint-panel">
              <h2>
                <Icon name="reply" size={15} /> Reply detection is off
              </h2>
              <p className="small muted">Reconnect Google once and replies move cards to “Replied” on their own. Headers only, never message text.</p>
              <a className="button small primary" href="/auth/google">
                Reconnect Google
              </a>
            </section>
          )}
        </aside>
      </div>

      {adding && (
        <AddJob
          stage="wishlist"
          onClose={() => setAdding(false)}
          onAdded={(company) => {
            setAdding(false);
            setToast(`Added ${company} to your wishlist`);
            reload();
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast('')} />}
    </div>
  );
}
