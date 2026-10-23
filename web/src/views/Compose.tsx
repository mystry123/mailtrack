import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { lintEmail } from '../../../src/shared/lint';
import { isDirectLink, renderBody, withSignature } from '../../../src/shared/render';
import { api, type Application, type EnhanceResult, type Me, type Message, type Resume, type ResumePick, type SavedLink, type Template } from '../api';
import { AppPicker, Modal, StageBadge, type PickedApp } from '../components';
import { insertBlock, insertText, link, prefixLines, swapResume, wrap, type TextEdit } from '../editing';
import { ago, parseAddresses } from '../format';
import { Icon } from '../icons';
import { go } from '../nav';
import { describe, presets, wallTimeToDate, ZONES } from '../schedule';

const DRAFT_KEY = 'mailtrack:draft';

interface Draft {
  to: string;
  cc: string;
  label: string;
  subject: string;
  body: string;
  includeSignature: boolean;
  app: PickedApp;
}

const EMPTY: Draft = { to: '', cc: '', label: '', subject: '', body: '', includeSignature: true, app: {} };

function loadDraft(): Draft {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') };
  } catch {
    return EMPTY;
  }
}

function saveDraft(d: Draft | null) {
  try {
    if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // private mode: drafts just don't persist
  }
}

const AI_PRESETS = [
  ['Polish', ''],
  ['Tailor to the job', 'Tailor this to the role and job description: connect my real experience to what they need.'],
  ['Shorter', 'Make it shorter and punchier: 3-5 sentences, keep every link.'],
  ['More confident', 'Make it more confident and specific, without sounding arrogant.'],
  ['Friendlier', 'Make it warmer and more conversational.'],
  ['Fix grammar only', 'Only fix grammar, spelling and punctuation. Change nothing else.'],
  ['Better subject', 'Only improve the subject line; return the body unchanged.'],
] as const;

const fmtAddr = (r: { email: string; name?: string }) => (r.name ? `${r.name} <${r.email}>` : r.email);
const reSubject = (s: string) => (/^re:/i.test(s.trim()) ? s.trim() : `Re: ${s.trim()}`);

interface AiState {
  busy: boolean;
  error: string;
  result: EnhanceResult | null;
  previous: Pick<Draft, 'subject' | 'body'> | null;
}

interface DupCheck {
  messages: Pick<Message, '_id' | 'subject' | 'to' | 'sentAt' | 'stats' | 'status'>[];
  applications: Pick<Application, '_id' | 'company' | 'role' | 'stage'>[];
}

export function Compose({ me, params }: { me: Me; params: URLSearchParams }) {
  const followUpId = params.get('followup');
  const againId = params.get('again');
  const appParam = params.get('app');
  const thankYouApp = params.get('thankyou');
  const thankYouKey = params.get('key');
  const referralContact = params.get('referral');
  const toParam = params.get('to');
  // Only a plain "New email" keeps a local draft; prefilled ones start from their source.
  const plain = !followUpId && !againId && !appParam && !thankYouApp && !referralContact && !toParam;

  const [draft, setDraft] = useState<Draft>(() =>
    plain ? loadDraft() : { ...EMPTY, to: toParam ?? '', app: appParam || thankYouApp ? { applicationId: (appParam || thankYouApp)! } : {} },
  );
  const [sequence, setSequence] = useState({ on: me.sequenceByDefault, days: me.sequenceDays.length ? me.sequenceDays : [4, 9] });
  const [trackOpens, setTrackOpens] = useState(true);
  const [templateId, setTemplateId] = useState<string | undefined>();
  const [confirmSend, setConfirmSend] = useState(false);
  const [prefilling, setPrefilling] = useState('');
  const [followUp, setFollowUp] = useState<{ id: string; subject: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [apps, setApps] = useState<Application[]>([]);
  const [saved, setSaved] = useState<SavedLink[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [ai, setAi] = useState<AiState>({ busy: false, error: '', result: null, previous: null });
  const [schedule, setSchedule] = useState<{ on: boolean; local: string; tz: string }>({ on: false, local: presets()[0].value, tz: '' });
  const [dups, setDups] = useState<DupCheck | null>(null);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [suggested, setSuggested] = useState<{ busy: boolean; pick: ResumePick | null }>({ busy: false, pick: null });
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ links: SavedLink[] }>('/api/saved-links').then((r) => setSaved(r.links)).catch(() => undefined);
    api<{ applications: Application[] }>('/api/applications').then((r) => setApps(r.applications)).catch(() => undefined);
    api<{ templates: Template[] }>('/api/templates').then((r) => setTemplates(r.templates)).catch(() => undefined);
    api<{ resumes: Resume[] }>('/api/resumes').then((r) => setResumes(r.resumes)).catch(() => undefined);
  }, []);

  // Prefill from a follow-up or "send again".
  useEffect(() => {
    const id = followUpId || againId;
    if (!id) return;
    api<{ message: Message }>(`/api/messages/${id}`)
      .then(({ message: m }) => {
        const app: PickedApp = m.applicationId ? { applicationId: m.applicationId } : {};
        if (followUpId) {
          setFollowUp({ id: m._id, subject: m.subject });
          setDraft({ ...EMPTY, to: m.to.map(fmtAddr).join(', '), cc: m.cc.map(fmtAddr).join(', '), subject: reSubject(m.subject), label: m.label, app });
        } else {
          setDraft({
            ...EMPTY,
            to: m.to.map(fmtAddr).join(', '),
            cc: m.cc.map(fmtAddr).join(', '),
            subject: m.subject,
            body: m.body ?? '',
            label: m.label,
            includeSignature: m.includeSignature ?? true,
            app,
          });
          setNotice('Same subject and message as before. Change the recipients to send it somewhere new.');
        }
      })
      .catch((e) => setError(e.message));
  }, [followUpId, againId]);

  // Thank-you note after an interview, or a referral ask: Gemini drafts it.
  useEffect(() => {
    if (!thankYouApp && !referralContact) return;
    setPrefilling(thankYouApp ? 'Gemini is drafting your thank-you note…' : 'Gemini is drafting your referral ask…');
    const req = thankYouApp
      ? api<EnhanceResult & { to: string[] }>('/api/ai/thankyou', { method: 'POST', body: { applicationId: thankYouApp, key: thankYouKey } }).then((d) => ({
          ...d,
          to: d.to.join(', '),
          applicationId: thankYouApp,
        }))
      : Promise.all([
          api<EnhanceResult & { applicationId?: string }>('/api/ai/referral', { method: 'POST', body: { contactId: referralContact, applicationId: appParam || undefined } }),
          api<{ contact: { name: string; email: string } }>(`/api/contacts/${referralContact}`),
        ]).then(([d, c]) => ({ ...d, to: c.contact.email ? fmtAddr({ email: c.contact.email, name: c.contact.name }) : '', applicationId: d.applicationId }));
    req
      .then((d) => {
        setDraft((x) => ({ ...x, to: d.to, subject: d.subject, body: d.body, app: d.applicationId ? { applicationId: d.applicationId } : x.app }));
        setSequence((s) => ({ ...s, on: false }));
        if (d.notes) setNotice(d.notes);
      })
      .catch((e) => setError(e.message))
      .finally(() => setPrefilling(''));
  }, [thankYouApp, thankYouKey, referralContact, appParam]);

  useEffect(() => {
    if (plain) saveDraft(draft);
  }, [draft, plain]);

  const set = (k: 'to' | 'cc' | 'subject' | 'body') => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  const hasSignature = !!me.signature.trim();
  const fullBody = draft.includeSignature ? withSignature(draft.body, me.signature) : draft.body;
  const preview = useMemo(() => renderBody(fullBody || ' '), [fullBody]);
  const to = parseAddresses(draft.to);
  const cc = parseAddresses(draft.cc);
  const linkedApp = draft.app.applicationId ? apps.find((a) => a._id === draft.app.applicationId) : undefined;

  // Which of your resumes this email carries, and which one fits the job.
  const resumeInBody = resumes.find((r) => draft.body.includes(r.url));
  const newRole = draft.app.newApplication?.role ?? '';
  const newCompany = draft.app.newApplication?.company ?? '';
  useEffect(() => {
    if (followUp || resumes.length < 2 || (!draft.app.applicationId && !newRole.trim())) return setSuggested({ busy: false, pick: null });
    let live = true;
    const t = setTimeout(() => {
      setSuggested({ busy: true, pick: null });
      api<{ pick: ResumePick | null }>('/api/resumes/pick', {
        method: 'POST',
        body: draft.app.applicationId ? { applicationId: draft.app.applicationId } : { company: newCompany, role: newRole },
      })
        .then((r) => live && setSuggested({ busy: false, pick: r.pick }))
        .catch(() => live && setSuggested({ busy: false, pick: null }));
    }, 700);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [draft.app.applicationId, newRole, newCompany, resumes.length, followUp]);

  const chooseResume = (r: Resume) =>
    setDraft((d) => ({
      ...d,
      body: swapResume(
        d.body,
        resumes.map((x) => x.url),
        r.url,
      ),
    }));
  const suggestedResume = resumes.find((r) => r._id === suggested.pick?.resumeId);

  // Warn before contacting someone (or a company) twice. Not for follow-ups: that's the point.
  const toKey = to.ok.map((r) => r.email.toLowerCase()).join(',');
  const company = linkedApp?.company ?? draft.app.newApplication?.company ?? '';
  useEffect(() => {
    if (followUp || thankYouApp || (!toKey && !company)) return setDups(null);
    const t = setTimeout(() => {
      api<DupCheck>(`/api/contacts/check?${new URLSearchParams({ emails: toKey, company: draft.app.newApplication ? company : '' })}`)
        .then(setDups)
        .catch(() => setDups(null));
    }, 500);
    return () => clearTimeout(t);
  }, [toKey, company, followUp, thankYouApp, draft.app.newApplication]);

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
    const map: Record<string, () => void> = { b: TOOLS[0].run, i: TOOLS[1].run, u: TOOLS[2].run, k: TOOLS[8].run };
    if (map[k]) {
      e.preventDefault();
      map[k]();
    } else if (k === 'enter') {
      e.preventDefault();
      void send();
    }
  };

  const runAi = async (call: () => Promise<EnhanceResult>) => {
    setAi((a) => ({ ...a, busy: true, error: '' }));
    try {
      const result = await call();
      setAi({ busy: false, error: '', result, previous: { subject: draft.subject, body: draft.body } });
      setDraft((d) => ({ ...d, subject: followUp ? d.subject : result.subject || d.subject, body: result.body }));
    } catch (err) {
      setAi((a) => ({ ...a, busy: false, error: (err as Error).message }));
    }
  };

  const enhance = (preset?: string) =>
    runAi(() =>
      api<EnhanceResult>('/api/ai/enhance', {
        method: 'POST',
        body: {
          subject: draft.subject,
          body: draft.body,
          instruction: preset ?? instruction.trim(),
          to: draft.to,
          label: draft.label,
          applicationId: draft.app.applicationId,
        },
      }),
    ).then(() => !preset && setInstruction(''));

  const draftFollowUp = () =>
    runAi(() => api<EnhanceResult>('/api/ai/followup', { method: 'POST', body: { messageId: followUp!.id, instruction: instruction.trim() } }));

  const undoAi = () => {
    if (!ai.previous) return;
    setDraft((d) => ({ ...d, ...ai.previous! }));
    setAi({ busy: false, error: '', result: null, previous: null });
  };

  const applyTemplate = (t: Template) => {
    setDraft((d) => ({ ...d, subject: t.subject || d.subject, body: t.body }));
    setTemplateId(t._id);
    setNotice(`Template "${t.name}" applied.`);
  };

  const saveTemplate = async (name: string) => {
    const r = await api<{ template: Template }>('/api/templates', { method: 'POST', body: { name, subject: draft.subject, body: draft.body } });
    setTemplates((ts) => [r.template, ...ts.filter((t) => t._id !== r.template._id)]);
    setSaveAs(null);
    setNotice(`Saved as template "${name}".`);
  };

  const scheduledAt = schedule.on && schedule.local ? wallTimeToDate(schedule.local, schedule.tz) : null;

  const problems: string[] = [];
  if (to.ok.length === 0) problems.push('Add at least one recipient');
  if (to.bad.length || cc.bad.length) problems.push(`Not an email address: ${[...to.bad, ...cc.bad].join(', ')}`);
  if (!draft.subject.trim()) problems.push('Add a subject');
  if (!draft.body.trim()) problems.push('Write something');
  if (scheduledAt && scheduledAt.getTime() < Date.now()) problems.push('Pick a time in the future');

  const lint = lintEmail({ subject: draft.subject, body: draft.body, recipientName: to.ok[0]?.name, company: linkedApp?.company ?? draft.label });
  const lintErrors = lint.filter((l) => l.level === 'error');
  const capLeft = me.dailyCap > 0 ? me.dailyCap - me.sentToday : Infinity;

  const send = async (force = false) => {
    if (sending) return;
    if (problems.length) return setError(problems[0]);
    if (lintErrors.length && !force) return setConfirmSend(true);
    setConfirmSend(false);
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
          ...draft.app,
          followUpOf: followUp?.id,
          scheduledAt: scheduledAt?.toISOString(),
          trackOpens,
          templateId,
          resumeId: resumeInBody?._id,
          sequenceDays: !followUp && sequence.on ? sequence.days : undefined,
          thankYouFor: thankYouApp && thankYouKey ? { applicationId: thankYouApp, key: thankYouKey } : undefined,
        },
      });
      if (plain) saveDraft(null);
      go(`/m/${r.message._id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{followUp ? 'Follow up' : againId ? 'Send again' : thankYouApp ? 'Thank-you note' : referralContact ? 'Ask for a referral' : 'New email'}</h1>
          <p className="muted">
            {followUp ? (
              <>
                Goes into the same Gmail thread as “{followUp.subject}”.
              </>
            ) : (
              'Opens, clicks and replies are tracked automatically.'
            )}
          </p>
        </div>
        {templates.length > 0 && !followUp && (
          <select
            className="template-select"
            value=""
            onChange={(e) => {
              const t = templates.find((x) => x._id === e.target.value);
              if (t) applyTemplate(t);
            }}
            aria-label="Use a template"
          >
            <option value="">Use a template…</option>
            {templates.map((t) => (
              <option key={t._id} value={t._id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </header>

      <div className="compose">
        <div className="card form">
          {prefilling && <div className="notice">{prefilling}</div>}
          {notice && <div className="notice">{notice}</div>}
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
              Company
              <AppPicker
                value={draft.app}
                apps={apps}
                onChange={({ label, ...app }) => setDraft((d) => ({ ...d, app, label }))}
              />
            </label>
            <label>
              Subject
              <input value={draft.subject} onChange={set('subject')} />
            </label>
          </div>
          {linkedApp && (
            <div className="linked small muted">
              Linked to <a href={`#/a/${linkedApp._id}`}>{linkedApp.company}</a> <StageBadge stage={linkedApp.stage} />
              {!followUp && linkedApp.stage === 'wishlist' && ' · moves to Reached out when sent'}
            </div>
          )}

          {resumes.length > 0 && !followUp && (
            <div className="resume-row">
              <span className="small muted">Resume</span>
              <div className="chips">
                {resumes.map((r) => (
                  <button
                    key={r._id}
                    type="button"
                    className={resumeInBody?._id === r._id ? 'chip on' : 'chip'}
                    title={r.readError ? `Couldn’t read it: ${r.readError}` : r.url}
                    onClick={() => chooseResume(r)}
                  >
                    {r.name}
                    {suggestedResume?._id === r._id && <span className="suggest-star" aria-label="suggested"> ★</span>}
                  </button>
                ))}
              </div>
              <span className="small muted resume-why">
                {suggested.busy
                  ? 'Finding the best fit…'
                  : suggestedResume
                    ? resumeInBody?._id === suggestedResume._id
                      ? `Best fit: ${suggested.pick!.reason}`
                      : `★ ${suggestedResume.name} fits best: ${suggested.pick!.reason}`
                    : resumes.length > 1 && !draft.app.applicationId && !newRole.trim()
                      ? 'Pick a company with a role to get a suggestion'
                      : ''}
              </span>
            </div>
          )}

          {dups && (dups.messages.length > 0 || dups.applications.length > 0) && (
            <div className="dup-warning">
              <strong>Heads up:</strong>
              {dups.messages.slice(0, 3).map((m) => (
                <div key={m._id}>
                  You emailed {m.to.map((r) => r.email).join(', ')} {ago(m.sentAt)} (“<a href={`#/m/${m._id}`}>{m.subject}</a>”)
                  {m.stats.replies ? ', and they replied' : m.stats.opens ? `, opened ${m.stats.opens}×` : ', no opens yet'}.
                </div>
              ))}
              {dups.applications.map((a) => (
                <div key={a._id}>
                  <a href={`#/a/${a._id}`}>{a.company}</a> is already in your pipeline ({a.role || 'no role'}): pick it above to link this email.
                </div>
              ))}
            </div>
          )}

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
          <div className="hint small muted">⌘B / ⌘I / ⌘U / ⌘K format · ⌘↵ sends · links are tracked, Google Drive links go direct</div>
          {draft.body.trim() && lint.length > 0 && (
            <ul className="lint">
              {lint.map((l) => (
                <li key={l.message} className={l.level}>
                  <span aria-hidden>{l.level === 'error' ? '!' : '·'}</span> {l.message}
                </li>
              ))}
            </ul>
          )}

          <div className="ai">
            <div className="ai-head">
              <span className="ai-badge">
                <Icon name="spark" size={14} /> Gemini
              </span>
              <span className="small muted">
                {followUp ? 'Drafts a short follow-up from your original email.' : '3.1 Pro rewrites the subject and message; links stay as they are.'}
              </span>
            </div>
            {followUp ? (
              <div className="ai-ask">
                <input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Optional: “mention I shipped AI captions last week”"
                  disabled={ai.busy}
                />
                <button type="button" className="primary" disabled={ai.busy} onClick={draftFollowUp}>
                  {ai.busy ? 'Thinking…' : 'Draft follow-up'}
                </button>
              </div>
            ) : (
              <>
                <div className="chips">
                  {AI_PRESETS.filter(([l]) => l !== 'Tailor to the job' || draft.app.applicationId).map(([label, ask]) => (
                    <button
                      key={label}
                      type="button"
                      className="chip"
                      disabled={ai.busy || (!draft.body.trim() && label !== 'Tailor to the job')}
                      onClick={() => enhance(ask)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="ai-ask">
                  <input
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && instruction.trim() && enhance()}
                    placeholder={draft.body.trim() ? 'Or say what to change: “mention the AI captions work”' : 'Describe the email and Gemini drafts it'}
                    disabled={ai.busy}
                  />
                  <button type="button" className="primary" disabled={ai.busy || !instruction.trim()} onClick={() => enhance()}>
                    {ai.busy ? 'Thinking…' : draft.body.trim() ? 'Rewrite' : 'Draft'}
                  </button>
                </div>
              </>
            )}
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

          <div className="send-options">
            {hasSignature ? (
              <label className="check">
                <input type="checkbox" checked={draft.includeSignature} onChange={(e) => setDraft((d) => ({ ...d, includeSignature: e.target.checked }))} />
                Signature
              </label>
            ) : (
              <span className="small muted">
                Add a signature in <a href="#/settings">Settings</a>
              </span>
            )}
            <label className="check">
              <input type="checkbox" checked={schedule.on} onChange={(e) => setSchedule({ ...schedule, on: e.target.checked })} />
              Send later
            </label>
            <label className="check" title="Without the tracking image: clicks and replies still count. Use for important one-to-one emails.">
              <input type="checkbox" checked={trackOpens} onChange={(e) => setTrackOpens(e.target.checked)} />
              Track opens
            </label>
            {!followUp && (
              <button type="button" className="link-btn small" onClick={() => setSaveAs(draft.subject || 'My template')} disabled={!draft.body.trim()}>
                Save as template
              </button>
            )}
          </div>

          {!followUp && (
            <div className={sequence.on ? 'sequence-box on' : 'sequence-box'}>
              <label className="check">
                <input type="checkbox" checked={sequence.on} onChange={(e) => setSequence({ ...sequence, on: e.target.checked })} />
                <strong>Automatic follow-ups</strong>
              </label>
              <span className="small muted">
                {sequence.on ? (
                  <>
                    After{' '}
                    {sequence.days.map((d, i) => (
                      <span key={i}>
                        {i > 0 && (i === sequence.days.length - 1 ? ' and ' : ', ')}
                        <input
                          className="day-input"
                          type="number"
                          min={1}
                          max={60}
                          value={d}
                          aria-label={`Follow-up ${i + 1}, working days`}
                          onChange={(e) => setSequence({ ...sequence, days: sequence.days.map((x, j) => (j === i ? Math.max(1, Math.min(60, Number(e.target.value) || 1)) : x)) })}
                        />
                      </span>
                    ))}{' '}
                    working days with no reply. Gemini drafts them now; you can read and edit them on the email’s page. They stop when anyone replies.
                  </>
                ) : (
                  'Off: Today will remind you to follow up by hand.'
                )}
              </span>
            </div>
          )}

          {schedule.on && (
            <div className="schedule">
              <div className="chips">
                {presets().map((p) => (
                  <button key={p.label} type="button" className={schedule.local === p.value ? 'chip on' : 'chip'} onClick={() => setSchedule({ ...schedule, local: p.value })}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="two">
                <input type="datetime-local" value={schedule.local} onChange={(e) => setSchedule({ ...schedule, local: e.target.value })} aria-label="Send at" />
                <select value={schedule.tz} onChange={(e) => setSchedule({ ...schedule, tz: e.target.value })} aria-label="Time zone">
                  {ZONES.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.label}
                    </option>
                  ))}
                </select>
              </div>
              {scheduledAt && !isNaN(scheduledAt.getTime()) && <div className="small muted">Sends {describe(scheduledAt, schedule.tz)}. Mornings get opened most.</div>}
            </div>
          )}

          {error && <p className="error">{error}</p>}
          <div className="actions">
            {plain && (
              <button className="ghost" onClick={() => setDraft({ ...EMPTY, includeSignature: draft.includeSignature })} disabled={sending}>
                Clear
              </button>
            )}
            {me.dailyCap > 0 && (
              <span className={capLeft <= 5 ? 'small cap low' : 'small muted cap'} title="Daily limit protects your Gmail reputation (Settings)">
                {me.sentToday}/{me.dailyCap} today
              </span>
            )}
            <button className="primary" onClick={() => send()} disabled={sending || me.needsReauth || !!prefilling}>
              {sending ? 'Sending…' : schedule.on ? 'Schedule' : followUp ? 'Send follow-up' : 'Send tracked email'}
            </button>
          </div>
        </div>

        <div className="card preview-card">
          <h2>Preview</h2>
          <div className="preview-subject">{draft.subject || <span className="muted">No subject</span>}</div>
          <iframe className="preview" sandbox="" srcDoc={preview.html} title="Preview" />
          {preview.links.length > 0 && (
            <div className="small muted">
              {preview.links.some((l) => !isDirectLink(l.url)) && <>Tracked links: {preview.links.filter((l) => !isDirectLink(l.url)).map((l) => l.label).join(' · ')}</>}
              {preview.links.some((l) => isDirectLink(l.url)) && <> Direct (not tracked): {preview.links.filter((l) => isDirectLink(l.url)).map((l) => l.label).join(' · ')}</>}
            </div>
          )}
        </div>
      </div>

      {confirmSend && (
        <Modal title="Send anyway?" onClose={() => setConfirmSend(false)}>
          <ul className="lint">
            {lintErrors.map((l) => (
              <li key={l.message} className="error">
                <span aria-hidden>!</span> {l.message}
              </li>
            ))}
          </ul>
          <div className="actions">
            <button className="ghost" onClick={() => setConfirmSend(false)}>
              Fix it
            </button>
            <button className="primary" onClick={() => send(true)}>
              Send anyway
            </button>
          </div>
        </Modal>
      )}

      {saveAs !== null && (
        <Modal title="Save as template" onClose={() => setSaveAs(null)}>
          <div className="form">
            <label>
              Name
              <input autoFocus value={saveAs} onChange={(e) => setSaveAs(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveAs.trim() && saveTemplate(saveAs.trim())} />
            </label>
            <p className="small muted">Saves the subject and message (not the recipients). The same name overwrites.</p>
            <div className="actions">
              <button className="ghost" onClick={() => setSaveAs(null)}>
                Cancel
              </button>
              <button className="primary" disabled={!saveAs.trim()} onClick={() => saveTemplate(saveAs.trim())}>
                Save
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
