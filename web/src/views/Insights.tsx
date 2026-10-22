import { useMemo, useRef, useState, type ReactNode } from 'react';
import { SOURCE_LABEL } from '../../../src/shared/stages';
import { type Insights, type Me } from '../api';
import { Empty, useApi } from '../components';
import { weekStart } from '../format';

// One floating tooltip per chart; marks call show() on hover/focus.
function useTip() {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: ReactNode } | null>(null);
  const show = (e: React.MouseEvent | React.FocusEvent, text: ReactNode) => {
    const r = box.current?.getBoundingClientRect();
    const t = (e.currentTarget as Element).getBoundingClientRect();
    if (!r) return;
    setTip({ x: t.left - r.left + t.width / 2, y: t.top - r.top, text });
  };
  const hide = () => setTip(null);
  const node = tip && (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>
  );
  return { box, show, hide, node };
}

function pct(n: number, d: number) {
  return d ? Math.round((n / d) * 100) : 0;
}

function Funnel({ data }: { data: Insights['funnel'] }) {
  const max = Math.max(1, data[0]?.count ?? 0);
  const t = useTip();
  return (
    <div className="chart" ref={t.box}>
      {data.map((s, i) => {
        const prev = i > 0 ? data[i - 1].count : 0;
        return (
          <div key={s.stage} className="hbar-row">
            <span className="hbar-label">{s.label}</span>
            <span className="hbar-track">
              <span
                className="hbar"
                tabIndex={0}
                style={{ width: `${(s.count / max) * 100}%` }}
                onMouseEnter={(e) => t.show(e, `${s.count} ${s.label.toLowerCase()}${i > 0 ? ` · ${pct(s.count, prev)}% of the step before` : ''}`)}
                onFocus={(e) => t.show(e, `${s.count} ${s.label.toLowerCase()}`)}
                onMouseLeave={t.hide}
                onBlur={t.hide}
              />
            </span>
            <span className="hbar-value">
              {s.count}
              {i > 0 && <span className="muted"> · {pct(s.count, prev)}%</span>}
            </span>
          </div>
        );
      })}
      {t.node}
    </div>
  );
}

function BySource({ data }: { data: Insights['bySource'] }) {
  const t = useTip();
  const rows = [...data].sort((a, b) => pct(b.replied, b.started) - pct(a.replied, a.started));
  return (
    <div className="chart" ref={t.box}>
      {rows.map((s) => (
        <div key={s.source} className="hbar-row">
          <span className="hbar-label">{SOURCE_LABEL[s.source]}</span>
          <span className="hbar-track">
            <span
              className="hbar"
              tabIndex={0}
              style={{ width: `${pct(s.replied, s.started)}%` }}
              onMouseEnter={(e) => t.show(e, `${s.replied} of ${s.started} replied · ${s.interviewing} reached interviews`)}
              onFocus={(e) => t.show(e, `${s.replied} of ${s.started} replied`)}
              onMouseLeave={t.hide}
              onBlur={t.hide}
            />
          </span>
          <span className="hbar-value">
            {pct(s.replied, s.started)}% <span className="muted">of {s.started}</span>
          </span>
        </div>
      ))}
      {t.node}
    </div>
  );
}

function Weekly({ started, goal }: { started: string[]; goal: number }) {
  const t = useTip();
  const weeks = useMemo(() => {
    const start = weekStart().getTime();
    return Array.from({ length: 12 }, (_, i) => {
      const from = start - (11 - i) * 7 * 86_400_000;
      const to = from + 7 * 86_400_000;
      return { from: new Date(from), n: started.filter((s) => +new Date(s) >= from && +new Date(s) < to).length };
    });
  }, [started]);
  const max = Math.max(goal, ...weeks.map((w) => w.n), 1);
  return (
    <div className="chart" ref={t.box}>
      <div className="vbars" role="img" aria-label="Applications started per week, last 12 weeks">
        {goal > 0 && (
          <div className="goal-marker" style={{ bottom: `${(goal / max) * 100}%` }}>
            <span>goal {goal}</span>
          </div>
        )}
        {weeks.map((w, i) => (
          <div key={i} className="vbar-col">
            <span
              className={`vbar${i === weeks.length - 1 ? ' current' : ''}`}
              tabIndex={0}
              style={{ height: `${(w.n / max) * 100}%` }}
              onMouseEnter={(e) => t.show(e, `Week of ${w.from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}: ${w.n}`)}
              onFocus={(e) => t.show(e, `${w.n}`)}
              onMouseLeave={t.hide}
              onBlur={t.hide}
            />
          </div>
        ))}
      </div>
      <div className="vbar-axis">
        {weeks.map((w, i) => (
          <span key={i}>{i % 2 === 1 ? '' : w.from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
        ))}
      </div>
      {t.node}
    </div>
  );
}

// Reply rate per item (template, link, subject), with how many sent.
function RateBars({ rows }: { rows: { label: string; sent: number; replied: number; extra?: string }[] }) {
  const t = useTip();
  return (
    <div className="chart" ref={t.box}>
      {rows.map((r) => (
        <div key={r.label} className="hbar-row">
          <span className="hbar-label" title={r.label}>
            {r.label}
          </span>
          <span className="hbar-track">
            <span
              className="hbar"
              tabIndex={0}
              style={{ width: `${pct(r.replied, r.sent)}%` }}
              onMouseEnter={(e) => t.show(e, `${r.replied} of ${r.sent} replied${r.extra ? ` · ${r.extra}` : ''}`)}
              onFocus={(e) => t.show(e, `${r.replied} of ${r.sent} replied`)}
              onMouseLeave={t.hide}
              onBlur={t.hide}
            />
          </span>
          <span className="hbar-value">
            {pct(r.replied, r.sent)}% <span className="muted">of {r.sent}</span>
          </span>
        </div>
      ))}
      {t.node}
    </div>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function Heatmap({ events }: { events: Insights['engagement'] }) {
  const t = useTip();
  const { grid, max, best } = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const e of events) {
      if (e.type === 'reply') continue;
      const d = new Date(e.at);
      g[(d.getDay() + 6) % 7][d.getHours()]++;
    }
    let m = 0;
    let b = { day: 0, hour: 0, n: 0 };
    g.forEach((row, di) =>
      row.forEach((n, h) => {
        m = Math.max(m, n);
        if (n > b.n) b = { day: di, hour: h, n };
      }),
    );
    return { grid: g, max: m, best: b };
  }, [events]);
  const hourLabel = (h: number) => new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
  return (
    <div className="chart" ref={t.box}>
      {best.n > 0 && (
        <p className="headline">
          Most opens and clicks land on <strong>{DAYS[best.day]}</strong> around <strong>{hourLabel(best.hour)}</strong> (your time). Schedule
          sends just before.
        </p>
      )}
      <div className="heat" role="img" aria-label="Opens and clicks by weekday and hour">
        {grid.map((row, di) => (
          <div key={di} className="heat-row">
            <span className="heat-day">{DAYS[di]}</span>
            {row.map((n, h) => (
              <span
                key={h}
                className="heat-cell"
                style={{ ['--v' as string]: max ? n / max : 0 }}
                onMouseEnter={(e) => t.show(e, `${DAYS[di]} ${hourLabel(h)}: ${n}`)}
                onMouseLeave={t.hide}
              />
            ))}
          </div>
        ))}
        <div className="heat-row axis">
          <span className="heat-day" />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="heat-hour">
              {h % 6 === 0 ? hourLabel(h) : ''}
            </span>
          ))}
        </div>
      </div>
      {t.node}
    </div>
  );
}

export function InsightsView() {
  const { data, error } = useApi<Insights>('/api/insights');
  const me = useApi<Me>('/api/me').data;

  if (error) return <p className="error page">{error}</p>;
  if (!data) return <p className="muted page">Loading…</p>;

  const e = data.emails;
  const nothing = e.sent === 0 && data.funnel[0].count === 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Insights</h1>
          <p className="muted">What's working in your search, from your own numbers.</p>
        </div>
      </header>

      {nothing ? (
        <div className="card">
          <Empty icon="▤" title="Not enough data yet">
            Send a few emails and move jobs through your pipeline. Charts appear as soon as there's something to show.
          </Empty>
        </div>
      ) : (
        <>
          <div className="kpis six">
            <div className="kpi">
              <div className="kpi-n">{e.sent}</div>
              <div className="kpi-l">Emails sent</div>
            </div>
            <div className="kpi">
              <div className="kpi-n">{pct(e.opened, e.sent)}%</div>
              <div className="kpi-l">Open rate</div>
            </div>
            <div className="kpi">
              <div className="kpi-n">{pct(e.clicked, e.sent)}%</div>
              <div className="kpi-l">Click rate</div>
            </div>
            <div className="kpi">
              <div className="kpi-n">{pct(e.replied, e.sent)}%</div>
              <div className="kpi-l">Reply rate</div>
            </div>
            <div className="kpi">
              <div className="kpi-n">{e.avgReplyDays === null ? '—' : `${e.avgReplyDays.toFixed(1)}d`}</div>
              <div className="kpi-l">Avg. time to reply</div>
            </div>
            <div className="kpi">
              <div className="kpi-n">{data.sequences.replies}</div>
              <div className="kpi-l">Replies to automatic follow-ups ({data.sequences.sent} sent)</div>
            </div>
          </div>

          <div className="columns">
            <div className="col">
              <section className="card">
                <h2>Funnel</h2>
                <Funnel data={data.funnel} />
                <p className="muted small">
                  Closed: {data.closed.accepted} accepted · {data.closed.rejected} rejected · {data.closed.ghosted} ghosted · {data.closed.withdrawn}{' '}
                  withdrawn
                </p>
              </section>
              {(data.byTemplate.length > 0 || data.byLink.length > 0 || data.bySubject.length > 0) && (
                <section className="card">
                  <h2>What gets replies</h2>
                  {data.byTemplate.length > 0 && (
                    <>
                      <div className="eyebrow chart-label">By template</div>
                      <RateBars rows={data.byTemplate.map((t) => ({ label: t.name, sent: t.sent, replied: t.replied }))} />
                    </>
                  )}
                  {data.byLink.length > 0 && (
                    <>
                      <div className="eyebrow chart-label">By resume version / link</div>
                      <RateBars rows={data.byLink.map((l) => ({ label: l.label, sent: l.sent, replied: l.replied, extra: `${l.linkClicks} clicks on it` }))} />
                    </>
                  )}
                  {data.bySubject.length > 0 && (
                    <>
                      <div className="eyebrow chart-label">By subject line (used 2+ times)</div>
                      <RateBars rows={data.bySubject.map((s) => ({ label: s.subject, sent: s.sent, replied: s.replied }))} />
                    </>
                  )}
                  <p className="muted small">Counts a whole thread as replied if any email in it got a reply. Add resume versions as saved links in Settings to compare them.</p>
                </section>
              )}
              <section className="card">
                <h2>Reply rate by source</h2>
                {data.bySource.length ? <BySource data={data.bySource} /> : <p className="muted small">Set a source on your applications to compare channels.</p>}
              </section>
            </div>
            <div className="col">
              <section className="card">
                <h2>Applications per week</h2>
                <Weekly started={data.started} goal={me?.weeklyGoal ?? 20} />
              </section>
              <section className="card">
                <h2>When people engage</h2>
                {data.engagement.length ? <Heatmap events={data.engagement} /> : <p className="muted small">No opens or clicks yet.</p>}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
