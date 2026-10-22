import { useMemo, useState } from 'react';
import { OPEN_STAGES, STAGE_LABEL } from '../../../src/shared/stages';
import { api, type Me, type Today } from '../api';
import { Empty, Logo, StageBadge, Toast, useApi } from '../components';
import { ago, day, streak, when, weekStart } from '../format';
import { Icon } from '../icons';
import { go } from '../nav';

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function GoalRing({ done, goal }: { done: number; goal: number }) {
  const pct = goal ? Math.min(1, done / goal) : 0;
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <svg width="84" height="84" viewBox="0 0 84 84" className="ring" role="img" aria-label={`${done} of ${goal} this week`}>
      <circle cx="42" cy="42" r={r} className="ring-track" />
      <circle cx="42" cy="42" r={r} className="ring-fill" strokeDasharray={`${pct * c} ${c}`} transform="rotate(-90 42 42)" />
      <text x="42" y="40" textAnchor="middle" className="ring-n">
        {done}
      </text>
      <text x="42" y="56" textAnchor="middle" className="ring-l">
        of {goal}
      </text>
    </svg>
  );
}

export function TodayView({ me }: { me: Me }) {
  const { data, error, reload } = useApi<Today>('/api/today', 60_000);
  const [toast, setToast] = useState('');
  const [quick, setQuick] = useState({ company: '', role: '', jobUrl: '' });
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

  const addJob = async () => {
    if (!quick.company.trim()) return;
    setAdding(true);
    try {
      const r = await api<{ application: { _id: string } }>('/api/applications', {
        method: 'POST',
        body: { company: quick.company, role: quick.role, jobUrl: quick.jobUrl, stage: 'wishlist' },
      });
      setQuick({ company: '', role: '', jobUrl: '' });
      setToast(`Added ${quick.company} to your wishlist`);
      reload();
      void r;
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const patchApp = async (id: string, body: Record<string, unknown>, msg: string) => {
    await api(`/api/applications/${id}`, { method: 'PATCH', body });
    setToast(msg);
    reload();
  };

  const cancel = async (id: string) => {
    await api(`/api/messages/${id}/cancel`, { method: 'POST', body: {} });
    setToast('Scheduled email cancelled');
    reload();
  };

  const first = (me.fromName || me.name).split(' ')[0];
  const needs = data ? data.followUps.length + data.ghosted.length + data.scheduled.filter((s) => s.status === 'failed').length : 0;

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
            {data && ` · ${data.active} active application${data.active === 1 ? '' : 's'}`}
          </p>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="today-grid">
        <section className="card goal-card">
          <GoalRing done={week.done} goal={data?.goal ?? me.weeklyGoal} />
          <div className="goal-text">
            <div className="eyebrow">This week</div>
            <div className="goal-line">
              {week.done >= (data?.goal ?? me.weeklyGoal) && (data?.goal ?? 0) > 0
                ? 'Goal reached. Nice work.'
                : `${Math.max(0, (data?.goal ?? me.weeklyGoal) - week.done)} more to hit your goal`}
            </div>
            <div className="week-dots" aria-label="Applications per day this week">
              {week.days.map(({ d, n }) => (
                <span
                  key={d.toISOString()}
                  className={`dot-day${n ? ' on' : ''}${d.toDateString() === new Date().toDateString() ? ' today' : ''}`}
                  title={`${d.toLocaleDateString(undefined, { weekday: 'long' })}: ${n}`}
                >
                  <i style={{ height: `${Math.min(100, n * 25)}%` }} />
                  <b>{d.toLocaleDateString(undefined, { weekday: 'narrow' })}</b>
                </span>
              ))}
            </div>
            <div className="muted small">
              {week.streak > 0 ? `🔥 ${week.streak}-day streak` : 'Start a streak: reach out to one company today'}
            </div>
          </div>
        </section>

        <section className="card quick-card">
          <div className="eyebrow">Add a job</div>
          <div className="quick-form">
            <input placeholder="Company" value={quick.company} onChange={(e) => setQuick({ ...quick, company: e.target.value })} />
            <input placeholder="Role" value={quick.role} onChange={(e) => setQuick({ ...quick, role: e.target.value })} />
            <input
              placeholder="Job link (optional)"
              value={quick.jobUrl}
              onChange={(e) => setQuick({ ...quick, jobUrl: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && addJob()}
            />
            <button className="primary" onClick={addJob} disabled={adding || !quick.company.trim()}>
              Add
            </button>
          </div>
          {data && (
            <div className="stage-strip">
              {OPEN_STAGES.map((s) => (
                <a key={s} href="#/pipeline" className="stage-count">
                  <span className="n">{data.stageCounts[s] ?? 0}</span>
                  <span className="l">{STAGE_LABEL[s]}</span>
                </a>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="columns">
        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2>
                <Icon name="clock" size={16} /> Needs you {needs > 0 && <span className="count-pill">{needs}</span>}
              </h2>
            </div>
            {!data ? (
              <p className="muted">Loading…</p>
            ) : needs === 0 && data.interviews.length === 0 ? (
              <Empty icon="✓" title="Nothing due">
                Follow-ups show up here {me.followUpDays} working days after an email gets no reply.
              </Empty>
            ) : (
              <ul className="task-list">
                {data.interviews.map((a) => (
                  <li key={`i${a._id}`} className="task">
                    <Logo name={a.company} />
                    <div className="task-main">
                      <a href={`#/a/${a._id}`} className="task-title">
                        Interview with {a.company}
                      </a>
                      <div className="muted small">
                        {a.interviewAt && when(a.interviewAt)} · {a.role || 'role not set'}
                      </div>
                    </div>
                    <a className="button small" href={`#/a/${a._id}`}>
                      Prep
                    </a>
                  </li>
                ))}
                {data.followUps.map((f) => (
                  <li key={`f${f.message._id}`} className="task">
                    <Logo name={f.application.company} />
                    <div className="task-main">
                      <a href={`#/a/${f.application._id}`} className="task-title">
                        Follow up with {f.application.company}
                      </a>
                      <div className="muted small">
                        {f.followUpNumber === 1 ? 'First' : 'Last'} nudge · no reply in {f.daysSince} days
                        {f.message.stats.opens > 0 && ` · opened ${f.message.stats.opens}×`}
                      </div>
                    </div>
                    <button
                      className="ghost small"
                      onClick={() =>
                        patchApp(f.application._id, { snoozedUntil: new Date(Date.now() + 3 * 86_400_000).toISOString() }, 'Snoozed for 3 days')
                      }
                    >
                      Snooze
                    </button>
                    <a className="button small primary" href={`#/compose?followup=${f.message._id}`}>
                      Follow up
                    </a>
                  </li>
                ))}
                {data.ghosted.map((g) => (
                  <li key={`g${g.application._id}`} className="task">
                    <Logo name={g.application.company} />
                    <div className="task-main">
                      <a href={`#/a/${g.application._id}`} className="task-title">
                        {g.application.company} went quiet
                      </a>
                      <div className="muted small">Two follow-ups, nothing for {g.daysSince} days. Time to let it go?</div>
                    </div>
                    <button
                      className="ghost small"
                      onClick={() =>
                        patchApp(g.application._id, { snoozedUntil: new Date(Date.now() + 14 * 86_400_000).toISOString() }, 'Hidden for 2 weeks')
                      }
                    >
                      Keep
                    </button>
                    <button className="small" onClick={() => patchApp(g.application._id, { stage: 'ghosted' }, `${g.application.company} marked ghosted`)}>
                      Mark ghosted
                    </button>
                  </li>
                ))}
                {data.scheduled
                  .filter((s) => s.status === 'failed')
                  .map((s) => (
                    <li key={`x${s._id}`} className="task">
                      <span className="task-icon bad">!</span>
                      <div className="task-main">
                        <a href={`#/m/${s._id}`} className="task-title">
                          Scheduled email failed: {s.subject}
                        </a>
                        <div className="muted small">{s.sendError}</div>
                      </div>
                      <a className="button small" href={`#/m/${s._id}`}>
                        Fix
                      </a>
                    </li>
                  ))}
              </ul>
            )}
          </section>

          {data && data.scheduled.some((s) => s.status === 'scheduled') && (
            <section className="card">
              <h2>
                <Icon name="calendar" size={16} /> Scheduled
              </h2>
              <ul className="task-list">
                {data.scheduled
                  .filter((s) => s.status === 'scheduled')
                  .map((s) => (
                    <li key={s._id} className="task">
                      <Logo name={s.label || s.to[0]?.email || '?'} />
                      <div className="task-main">
                        <a href={`#/m/${s._id}`} className="task-title">
                          {s.subject}
                        </a>
                        <div className="muted small">
                          To {s.to.map((r) => r.name || r.email).join(', ')} · {s.scheduledAt && `${day(s.scheduledAt)}, ${new Date(s.scheduledAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}
                        </div>
                      </div>
                      <button className="ghost small" onClick={() => cancel(s._id)}>
                        Cancel
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </div>

        <div className="col">
          <section className="card">
            <h2>
              <Icon name="fire" size={16} /> Hot right now
            </h2>
            {!data ? (
              <p className="muted">Loading…</p>
            ) : data.hot.length === 0 ? (
              <Empty icon="◎" title="No fresh activity">
                Opens and clicks from the last 48 hours land here, so you can follow up while they're thinking about you.
              </Empty>
            ) : (
              <ul className="task-list">
                {data.hot.map((h) => {
                  const name = h.application?.company || h.message.label || h.message.to[0]?.name || h.message.to[0]?.email || 'Someone';
                  return (
                    <li key={h.message._id} className="task">
                      <Logo name={name} />
                      <div className="task-main">
                        <a href={`#/m/${h.message._id}`} className="task-title">
                          {name}{' '}
                          {h.clicks > 0 ? (
                            <span className="hot-tag click">clicked {h.clickedLabels.join(', ')}</span>
                          ) : (
                            <span className="hot-tag open">opened {h.opens > 1 ? `${h.opens}×` : ''}</span>
                          )}
                        </a>
                        <div className="muted small">
                          {ago(h.lastAt)} · {h.message.kind === 'link' ? 'tracked link' : h.message.subject}
                        </div>
                      </div>
                      {h.message.kind !== 'link' && (
                        <a className="button small" href={`#/compose?followup=${h.message._id}`} title="They're looking at it now">
                          Follow up
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>
              <Icon name="reply" size={16} /> Replies
            </h2>
            {!data ? (
              <p className="muted">Loading…</p>
            ) : data.replies.length === 0 ? (
              <Empty icon="↩" title="No replies yet">
                {me.replyDetection
                  ? 'Replies to emails sent from here appear within about 10 minutes.'
                  : 'Reconnect Google (banner above) to detect replies automatically.'}
              </Empty>
            ) : (
              <ul className="task-list">
                {data.replies.map((r, i) => {
                  const who = (r.from ?? '').replace(/<[^>]+>/, '').replace(/"/g, '').trim() || 'Someone';
                  return (
                    <li key={i} className="task">
                      <Logo name={r.application?.company || who} />
                      <div className="task-main">
                        <button className="task-title link-btn" onClick={() => r.message && go(`/m/${r.message._id}`)}>
                          {who} replied{r.application ? ` · ${r.application.company}` : ''}
                        </button>
                        <div className="muted small">
                          {ago(r.at)} · {r.message?.subject}
                        </div>
                      </div>
                      {r.application && <StageBadge stage={r.application.stage} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
      {toast && <Toast text={toast} onDone={() => setToast('')} />}
    </div>
  );
}
