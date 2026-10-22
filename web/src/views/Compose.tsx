import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { renderBody, withSignature } from '../../../src/shared/render';
import { api, type EnhanceResult, type Me, type SavedLink } from '../api';
import { insertBlock, insertText, link, prefixLines, wrap, type TextEdit } from '../editing';
import { parseAddresses } from '../format';
import { go } from '../nav';

const DRAFT_KEY = 'mailtrack:draft';

interface Draft {
  to: string;
  cc: string;
  label: string;
  subject: string;
  body: string;
  includeSignature: boolean;
}

const EMPTY: Draft = { to: '', cc: '', label: '', subject: '', body: '', includeSignature: true };

function loadDraft(): Draft {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') };
  } catch {
    return EMPTY;
  }
}

const AI_PRESETS = [
  ['Polish', ''],
  ['Shorter', 'Make it shorter and punchier: 3-5 sentences, keep every link.'],
  ['More confident', 'Make it more confident and specific, without sounding arrogant.'],
  ['Friendlier', 'Make it warmer and more conversational.'],
  ['Fix grammar only', 'Only fix grammar, spelling and punctuation. Change nothing else.'],
  ['Better subject', 'Only improve the subject line; return the body unchanged.'],
] as const;

interface AiState {
  busy: boolean;
  error: string;
  result: EnhanceResult | null;
  previous: Pick<Draft, 'subject' | 'body'> | null;
}

export function Compose({ me }: { me: Me }) {
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [saved, setSaved] = useState<SavedLink[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [ai, setAi] = useState<AiState>({ busy: false, error: '', result: null, previous: null });
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

  const set = (k: 'to' | 'cc' | 'label' | 'subject' | 'body') => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const hasSignature = !!me.signature.trim();
  const fullBody = draft.includeSignature ? withSignature(draft.body, me.signature) : draft.body;
  const preview = useMemo(() => renderBody(fullBody || ' '), [fullBody]);
  const to = parseAddresses(draft.to);
  const cc = parseAddresses(draft.cc);

  const apply = (fn: (value: string, start: number, end: number) => TextEdit) => {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? draft.body.length;
    const edit = fn(draft.body, start, end);
    setDraft((d) => ({ ...d, body: edit.value }));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(edit.start, edit.end);
    });
  };

  const TOOLS: Array<{ label: string; title: string; run: () => void; className?: string }> = [
    { label: 'B', title: 'Bold (⌘B)', className: 'b', run: () => apply((v, s, e) => wrap(v, s, e, '**', 'bold')) },
    { label: 'I', title: 'Italic (⌘I)', className: 'i', run: () => apply((v, s, e) => wrap(v, s, e, '*', 'italic')) },
    { label: 'U', title: 'Underline (⌘U)', className: 'u', run: () => apply((v, s, e) => wrap(v, s, e, '++', 'underlined')) },
    { label: 'S', title: 'Strikethrough', className: 's', run: () => apply((v, s, e) => wrap(v, s, e, '~~', 'struck')) },
    { label: 'H', title: 'Heading', run: () => apply((v, s, e) => prefixLines(v, s, e, 'heading')) },
    { label: '•', title: 'Bullet list', run: () => apply((v, s, e) => prefixLines(v, s, e, 'bullet')) },
    { label: '1.', title: 'Numbered list', run: () => apply((v, s, e) => prefixLines(v, s, e, 'number')) },
    { label: '❝', title: 'Quote', run: () => apply((v, s, e) => prefixLines(v, s, e, 'quote')) },
    { label: 'Link', title: 'Link (⌘K)', run: () => apply(link) },
    { label: '</>', title: 'Inline code', run: () => apply((v, s, e) => wrap(v, s, e, '`', 'code')) },
    { label: '—', title: 'Divider', run: () => apply((v, s, e) => insertBlock(v, s, e, '---')) },
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    const map: Record<string, () => void> = {
      b: TOOLS[0].run,
      i: TOOLS[1].run,
      u: TOOLS[2].run,
      k: TOOLS[8].run,
    };
    if (map[k]) {
      e.preventDefault();
      map[k]();
    } else if (k === 'enter') {
      e.preventDefault();
      void send();
    }
  };

  const enhance = async (preset?: string) => {
    const ask = preset ?? instruction.trim();
    setAi((a) => ({ ...a, busy: true, error: '' }));
    try {
      const result = await api<EnhanceResult>('/api/ai/enhance', {
        method: 'POST',
        body: { subject: draft.subject, body: draft.body, instruction: ask, to: draft.to, label: draft.label },
      });
      setAi({ busy: false, error: '', result, previous: { subject: draft.subject, body: draft.body } });
      setDraft((d) => ({ ...d, subject: result.subject || d.subject, body: result.body }));
      if (!preset) setInstruction('');
    } catch (err) {
      setAi((a) => ({ ...a, busy: false, error: (err as Error).message }));
    }
  };

  const undoAi = () => {
    if (!ai.previous) return;
    setDraft((d) => ({ ...d, ...ai.previous! }));
    setAi({ busy: false, error: '', result: null, previous: null });
  };

  const problems: string[] = [];
  if (to.ok.length === 0) problems.push('Add at least one recipient');
  if (to.bad.length || cc.bad.length) problems.push(`Not an email address: ${[...to.bad, ...cc.bad].join(', ')}`);
  if (!draft.subject.trim()) problems.push('Add a subject');
  if (!draft.body.trim()) problems.push('Write something');

  const send = async () => {
    if (sending) return;
    if (problems.length) return setError(problems[0]);
    setSending(true);
    setError('');
    try {
      const r = await api<{ message: { _id: string } }>('/api/messages/send', {
        method: 'POST',
        body: {
          to: to.ok,
          cc: cc.ok,
          subject: draft.subject,
          body: draft.body,
          label: draft.label,
          includeSignature: draft.includeSignature,
        },
      });
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // ignore
      }
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

        <div className="field-label">Message</div>
        <div className="editor">
          <div className="toolbar-row" role="toolbar" aria-label="Formatting">
            {TOOLS.map((t) => (
              <button
                key={t.title}
                type="button"
                className={`tool ${t.className ?? ''}`}
                title={t.title}
                aria-label={t.title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={t.run}
              >
                {t.label}
              </button>
            ))}
            {saved.length > 0 && <span className="tool-sep" />}
            {saved.map((l) => (
              <button
                key={l.label}
                type="button"
                className="tool chip-tool"
                title={`Insert ${l.url}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply((v, s, e) => insertText(v, s, e, `[${l.label}](${l.url})`))}
              >
                + {l.label}
              </button>
            ))}
          </div>
          <textarea ref={bodyRef} value={draft.body} onChange={set('body')} onKeyDown={onKeyDown} rows={14} />
        </div>
        <div className="hint small muted">
          Select text and use the toolbar or ⌘B / ⌘I / ⌘U / ⌘K. Every link is tracked. ⌘↵ sends.
        </div>

        <div className="ai">
          <div className="ai-head">
            <span className="ai-badge">✦ Gemini</span>
            <span className="small muted">3.1 Pro rewrites the subject and message; links stay as they are.</span>
          </div>
          <div className="chips">
            {AI_PRESETS.map(([label, ask]) => (
              <button key={label} type="button" className="chip" disabled={ai.busy || !draft.body.trim()} onClick={() => enhance(ask)}>
                {label}
              </button>
            ))}
          </div>
          <div className="ai-ask">
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && instruction.trim() && enhance()}
              placeholder={draft.body.trim() ? 'Or say what to change: "mention the AI captions work"' : 'Describe the email and Gemini drafts it'}
              disabled={ai.busy}
            />
            <button type="button" className="primary" disabled={ai.busy || !instruction.trim()} onClick={() => enhance()}>
              {ai.busy ? 'Thinking…' : draft.body.trim() ? 'Rewrite' : 'Draft'}
            </button>
          </div>
          {ai.busy && <p className="small muted">Gemini is working on it, usually 10–20 seconds.</p>}
          {ai.error && <p className="error small">{ai.error}</p>}
          {ai.result && ai.previous && (
            <div className="ai-result">
              <div>
                {ai.result.notes && <p className="small">{ai.result.notes}</p>}
                {ai.result.warnings.map((w) => (
                  <p key={w} className="error small">
                    {w}
                  </p>
                ))}
              </div>
              <button type="button" className="ghost small" onClick={undoAi}>
                Undo
              </button>
            </div>
          )}
        </div>

        {hasSignature ? (
          <label className="check inline">
            <input
              type="checkbox"
              checked={draft.includeSignature}
              onChange={(e) => setDraft((d) => ({ ...d, includeSignature: e.target.checked }))}
            />
            Include signature
          </label>
        ) : (
          <p className="small muted">
            Add a signature and "about me" for Gemini in <a href="#/settings">Settings</a>.
          </p>
        )}

        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="ghost" onClick={() => setDraft({ ...EMPTY, includeSignature: draft.includeSignature })} disabled={sending}>
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
        {preview.links.length > 0 && <div className="small muted">Tracked links: {preview.links.map((l) => l.label).join(' · ')}</div>}
      </div>
    </section>
  );
}
