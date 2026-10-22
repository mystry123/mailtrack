import { useEffect, useState } from 'react';
import { api, type Me, type Message, type Sequence, type SequenceStep } from '../api';
import { ago, when } from '../format';
import { Icon } from '../icons';

const STEP_LABEL: Record<SequenceStep['status'], string> = {
  pending: 'Scheduled',
  sent: 'Sent',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

function Step({ root, step, i, first, onChange }: { root: Message; step: SequenceStep; i: number; first: boolean; onChange: (s: Sequence, msg?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(step.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (path: string, body: unknown, msg: string, method = 'POST') => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ sequence: Sequence }>(`/api/messages/${root._id}/sequence${path}`, { method, body });
      onChange(r.sequence, msg);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pending = step.status === 'pending';
  return (
    <li className={`seq-step ${step.status}`}>
      <div className="seq-row">
        <span className={`seq-dot ${step.status}`} aria-hidden>
          {step.status === 'sent' ? '✓' : i + 1}
        </span>
        <div className="seq-main">
          <div className="seq-title">
            Follow-up {i + 1} <span className="muted">· {step.afterDays} working days after</span>
          </div>
          <div className="small muted">
            {STEP_LABEL[step.status]}
            {pending && ` for ${when(step.dueAt)} (${ago(step.dueAt)})`}
            {!step.body && pending && ' · Gemini is drafting it…'}
            {step.edited && ' · edited by you'}
          </div>
          {step.error && <div className="small error">Last attempt: {step.error}</div>}
        </div>
        <div className="seq-actions">
          {step.body && (
            <button className="ghost small" onClick={() => setOpen(!open)}>
              {open ? 'Hide' : 'Read'}
            </button>
          )}
          {step.status === 'sent' && step.messageId && (
            <a className="button small" href={`#/m/${step.messageId}`}>
              Open
            </a>
          )}
        </div>
      </div>
      {open && step.body && (
        <div className="seq-draft">
          <div className="small muted">Subject: {step.subject}</div>
          {editing ? (
            <>
              <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="actions">
                <button className="ghost small" onClick={() => (setEditing(false), setText(step.body))}>
                  Cancel
                </button>
                <button className="primary small" disabled={busy || !text.trim()} onClick={() => run(`/${i}`, { body: text }, 'Follow-up saved', 'PATCH')}>
                  Save
                </button>
              </div>
            </>
          ) : (
            <p className="seq-body">{step.body}</p>
          )}
          {pending && !editing && (
            <div className="actions">
              <button className="ghost small" disabled={busy} onClick={() => run(`/${i}/skip`, {}, 'Skipped')}>
                Skip this one
              </button>
              <button className="small" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </button>
              {first && (
                <button className="primary small" disabled={busy} onClick={() => run(`/${i}/send-now`, {}, 'Follow-up sent')}>
                  Send now
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {error && <div className="small error">{error}</div>}
    </li>
  );
}

export function SequenceCard({
  message,
  me,
  onChange,
  onRefresh,
}: {
  message: Message;
  me?: Me | null;
  onChange: (msg: string) => void;
  onRefresh?: () => void;
}) {
  const [seq, setSeq] = useState<Sequence | undefined>(message.sequence);
  // The page refreshes every few seconds (drafts arrive, steps go out): follow the server.
  useEffect(() => setSeq(message.sequence), [message.sequence]);
  // Drafts arrive a few seconds after sending: check often until they're in.
  const drafting = !!seq?.steps.some((s) => s.status === 'pending' && !s.body);
  useEffect(() => {
    if (!drafting || !onRefresh) return;
    const t = setInterval(onRefresh, 2000);
    return () => clearInterval(t);
  }, [drafting, onRefresh]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const update = (s: Sequence, msg?: string) => {
    setSeq(s);
    if (msg) onChange(msg);
  };

  if (!seq) {
    // A first email sent without automatic follow-ups: offer to add them.
    const days = me?.sequenceDays?.length ? me.sequenceDays : [4, 9];
    const start = async () => {
      setBusy(true);
      setError('');
      try {
        const r = await api<{ sequence: Sequence }>(`/api/messages/${message._id}/sequence`, { method: 'POST', body: { days } });
        update(r.sequence, 'Automatic follow-ups on');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    };
    return (
      <section className="card">
        <h2>
          <Icon name="clock" size={15} /> Automatic follow-ups
        </h2>
        <p className="small muted">
          Off for this email. Turn them on and Gemini drafts follow-ups for {days.join(' and ')} working days from now; they stop as soon as anyone replies.
        </p>
        {error && <p className="small error">{error}</p>}
        <button className="small" onClick={start} disabled={busy}>
          Turn on
        </button>
      </section>
    );
  }

  const firstPending = seq.steps.findIndex((s) => s.status === 'pending');
  const stop = async () => {
    setBusy(true);
    try {
      const r = await api<{ sequence: Sequence }>(`/api/messages/${message._id}/sequence/stop`, { method: 'POST', body: {} });
      update(r.sequence, 'Automatic follow-ups stopped');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <Icon name="clock" size={15} /> Automatic follow-ups
        </h2>
        <span className={`pill ${seq.status === 'active' ? 'scheduled' : ''}`}>{seq.status === 'active' ? 'On' : seq.status === 'done' ? 'Done' : 'Stopped'}</span>
      </div>
      {seq.stopReason && <p className="small muted">Stopped: {seq.stopReason}.</p>}
      <ol className="seq">
        {seq.steps.map((s, i) => (
          <Step key={s._id ?? i} root={message} step={s} i={i} first={i === firstPending} onChange={update} />
        ))}
      </ol>
      {seq.status === 'active' && (
        <div className="actions">
          <button className="ghost small" onClick={stop} disabled={busy}>
            Stop all
          </button>
        </div>
      )}
    </section>
  );
}
