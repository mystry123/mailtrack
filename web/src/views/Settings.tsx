import { useEffect, useState } from 'react';
import { api, type Me, type SavedLink, type Template } from '../api';
import { Toast } from '../components';

export function Settings({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [fromName, setFromName] = useState(me.fromName || me.name);
  const [signature, setSignature] = useState(me.signature);
  const [aboutMe, setAboutMe] = useState(me.aboutMe);
  const [weeklyGoal, setWeeklyGoal] = useState(me.weeklyGoal);
  const [followUpDays, setFollowUpDays] = useState(me.followUpDays);
  const [links, setLinks] = useState<SavedLink[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api<{ links: SavedLink[] }>('/api/saved-links').then((r) => setLinks(r.links)).catch((e) => setError(e.message));
    api<{ templates: Template[] }>('/api/templates').then((r) => setTemplates(r.templates)).catch(() => undefined);
  }, []);

  const update = (i: number, patch: Partial<SavedLink>) => setLinks(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    setError('');
    try {
      await api('/api/me', { method: 'PUT', body: { fromName, signature, aboutMe, weeklyGoal, followUpDays } });
      const clean = links.filter((l) => l.label.trim() || l.url.trim());
      const r = await api<{ links: SavedLink[] }>('/api/saved-links', { method: 'PUT', body: { links: clean } });
      setLinks(r.links);
      setToast('Settings saved');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteTemplate = async (t: Template) => {
    await api(`/api/templates/${t._id}`, { method: 'DELETE' });
    setTemplates(templates.filter((x) => x._id !== t._id));
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const r = await api<{ found: number }>('/api/replies/check', { method: 'POST', body: {} });
      setToast(r.found ? `Found ${r.found} new repl${r.found === 1 ? 'y' : 'ies'}` : 'No new replies');
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="page narrow">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Signed in as {me.email}</p>
        </div>
        <button className="primary" onClick={save}>
          Save settings
        </button>
      </header>
      {error && <p className="error">{error}</p>}

      <section className="card form">
        <h2>Sender</h2>
        <label>
          From name
          <input value={fromName} onChange={(e) => setFromName(e.target.value)} />
        </label>
        <label>
          Signature
          <textarea
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            rows={4}
            placeholder={'**Ritik Patel**\nFullstack engineer · [Shotline](https://shotline.in)'}
          />
        </label>
        <p className="small muted">Same formatting as Compose. Links in it are tracked too.</p>
      </section>

      <section className="card form">
        <h2>Job search</h2>
        <div className="two">
          <label>
            Weekly goal (applications started)
            <input type="number" min={0} max={200} value={weeklyGoal} onChange={(e) => setWeeklyGoal(Number(e.target.value))} />
          </label>
          <label>
            Follow up after (working days without a reply)
            <input type="number" min={1} max={30} value={followUpDays} onChange={(e) => setFollowUpDays(Number(e.target.value))} />
          </label>
        </div>
        <p className="small muted">The second follow-up comes after twice as long; after two with no answer, Today suggests marking it ghosted.</p>
        <div className="setting-row">
          <div>
            <strong>Reply detection</strong>
            <div className="small muted">
              {me.replyDetection
                ? 'On. Checks the threads you sent from here every 10 minutes (headers only, never message text).'
                : 'Off. Reconnect Google and allow “View your email message metadata”.'}
            </div>
          </div>
          {me.replyDetection ? (
            <button className="small" onClick={checkNow} disabled={checking}>
              {checking ? 'Checking…' : 'Check now'}
            </button>
          ) : (
            <a className="button small primary" href="/auth/google">
              Reconnect
            </a>
          )}
        </div>
      </section>

      <section className="card form">
        <h2>About me (for Gemini)</h2>
        <label>
          Background Gemini can use, and never goes beyond
          <textarea
            value={aboutMe}
            onChange={(e) => setAboutMe(e.target.value)}
            rows={6}
            placeholder="Fullstack engineer. Built Shotline, a browser video editor: timeline, Remotion rendering on Lambda, AI captions, auto-reframe, an AI assistant. Looking for founding / fullstack roles at AI startups."
          />
        </label>
        <p className="small muted">Gemini is told never to invent achievements, so anything you want it to mention belongs here or in the draft.</p>
      </section>

      <section className="card form">
        <h2>Saved links</h2>
        <p className="small muted">One-click inserts for Compose and Tracked link: resume, demo, portfolio.</p>
        {links.map((l, i) => (
          <div key={i} className="saved-row">
            <input value={l.label} placeholder="Resume" onChange={(e) => update(i, { label: e.target.value })} />
            <input value={l.url} placeholder="https://drive.google.com/…" onChange={(e) => update(i, { url: e.target.value })} />
            <button className="ghost small" onClick={() => setLinks(links.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button className="ghost" onClick={() => setLinks([...links, { label: '', url: '' }])}>
          + Add link
        </button>
      </section>

      <section className="card form">
        <h2>Templates</h2>
        {templates.length === 0 ? (
          <p className="small muted">None yet. In Compose, “Save as template” keeps a subject and message you reuse.</p>
        ) : (
          <ul className="task-list">
            {templates.map((t) => (
              <li key={t._id} className="task">
                <div className="task-main">
                  <strong>{t.name}</strong>
                  <div className="muted small">{t.subject || 'No subject'}</div>
                </div>
                <button className="ghost small" onClick={() => deleteTemplate(t)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card form">
        <h2>Chrome extension</h2>
        <p className="small muted">
          Stops your own Gmail views from counting as opens. In Chrome: <code>chrome://extensions</code> → Developer mode → Load unpacked → the{' '}
          <code>extension/</code> folder of the mailtrack repo.
        </p>
      </section>

      <div className="actions">
        <button className="primary" onClick={save}>
          Save settings
        </button>
      </div>
      {toast && <Toast text={toast} onDone={() => setToast('')} />}
    </div>
  );
}
