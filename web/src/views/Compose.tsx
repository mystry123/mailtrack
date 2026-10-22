import { useEffect, useMemo, useRef, useState } from 'react';
import { renderBody } from '../../../src/shared/render';
import { api, type Me, type SavedLink } from '../api';
import { parseAddresses } from '../format';
import { go } from '../nav';

const DRAFT_KEY = 'mailtrack:draft';

interface Draft {
  to: string;
  cc: string;
  label: string;
  subject: string;
  body: string;
}

const EMPTY: Draft = { to: '', cc: '', label: '', subject: '', body: '' };

function loadDraft(): Draft {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') };
  } catch {
    return EMPTY;
  }
}

export function Compose({ me }: { me: Me }) {
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [saved, setSaved] = useState<SavedLink[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ links: SavedLink[] }>('/api/saved-links').then((r) => setSaved(r.links)).catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // private mode: drafts just don't persist
    }
  }, [draft]);

  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });

  const preview = useMemo(() => renderBody(draft.body || ' '), [draft.body]);
  const to = parseAddresses(draft.to);
  const cc = parseAddresses(draft.cc);

  const insertLink = (l: SavedLink) => {
    const el = bodyRef.current;
    const snippet = `[${l.label}](${l.url})`;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? draft.body.length;
    const body = draft.body.slice(0, start) + snippet + draft.body.slice(end);
    setDraft({ ...draft, body });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  const problems: string[] = [];
  if (to.ok.length === 0) problems.push('Add at least one recipient');
  if (to.bad.length || cc.bad.length) problems.push(`Not an email address: ${[...to.bad, ...cc.bad].join(', ')}`);
  if (!draft.subject.trim()) problems.push('Add a subject');
  if (!draft.body.trim()) problems.push('Write something');

  const send = async () => {
    if (problems.length) return setError(problems[0]);
    setSending(true);
    setError('');
    try {
      const r = await api<{ message: { _id: string } }>('/api/messages/send', {
        method: 'POST',
        body: { to: to.ok, cc: cc.ok, subject: draft.subject, body: draft.body, label: draft.label },
      });
      localStorage.removeItem(DRAFT_KEY);
      go(`/m/${r.message._id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="compose">
      <div className="card form">
        <div className="from muted small">From {me.fromName || me.name ? `${me.fromName || me.name} <${me.email}>` : me.email}</div>
        <label>
          To
          <input value={draft.to} onChange={set('to')} placeholder="Jane Doe <jane@company.com>, other@company.com" />
        </label>
        <label>
          Cc
          <input value={draft.cc} onChange={set('cc')} placeholder="optional" />
        </label>
        <div className="two">
          <label>
            Company / tag
            <input value={draft.label} onChange={set('label')} placeholder="Cardboard" />
          </label>
          <label>
            Subject
            <input value={draft.subject} onChange={set('subject')} />
          </label>
        </div>
        <label>
          Message
          <textarea ref={bodyRef} value={draft.body} onChange={set('body')} rows={14} />
        </label>
        <div className="hint small muted">
          Blank line = new paragraph · <code>[Resume](https://…)</code> for a named link · <code>**bold**</code>. Every link is
          tracked.
        </div>
        {saved.length > 0 && (
          <div className="chips">
            <span className="small muted">Insert:</span>
            {saved.map((l) => (
              <button key={l.label} className="chip" onClick={() => insertLink(l)}>
                + {l.label}
              </button>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="ghost" onClick={() => setDraft(EMPTY)} disabled={sending}>
            Clear
          </button>
          <button className="primary" onClick={send} disabled={sending || me.needsReauth}>
            {sending ? 'Sending…' : 'Send tracked email'}
          </button>
        </div>
      </div>

      <div className="card preview-card">
        <h2>Preview</h2>
        <div className="preview-subject">{draft.subject || <span className="muted">No subject</span>}</div>
        <iframe className="preview" sandbox="" srcDoc={preview.html} title="Preview" />
        {preview.links.length > 0 && (
          <div className="small muted">
            Tracked links: {preview.links.map((l) => l.label).join(' · ')}
          </div>
        )}
      </div>
    </section>
  );
}
