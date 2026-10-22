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
  const [sequenceByDefault, setSequenceByDefault] = useState(me.sequenceByDefault);
  const [sequenceDays, setSequenceDays] = useState(me.sequenceDays.join(', '));
  const [dailyCap, setDailyCap] = useState(me.dailyCap);
  const [timezone, setTimezone] = useState(me.timezone);
  const [weeklyDigest, setWeeklyDigest] = useState(me.weeklyDigest);
  const [digest, setDigest] = useState<{ subject: string; markdown: string } | null>(null);
  const [busy, setBusy] = useState('');
  const zones = (() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    } catch {
      return [me.timezone];
    }
  })();

  useEffect(() => {
    api<{ links: SavedLink[] }>('/api/saved-links').then((r) => setLinks(r.links)).catch((e) => setError(e.message));
    api<{ templates: Template[] }>('/api/templates').then((r) => setTemplates(r.templates)).catch(() => undefined);
  }, []);

  const update = (i: number, patch: Partial<SavedLink>) => setLinks(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    setError('');
    try {
      const days = sequenceDays
        .split(/[,\s]+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0 && n <= 60)
        .slice(0, 3);
      await api('/api/me', {
        method: 'PUT',
        body: { fromName, signature, aboutMe, weeklyGoal, followUpDays, sequenceByDefault, sequenceDays: days.length ? days : [4, 9], dailyCap, timezone, weeklyDigest },
      });
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

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      setToast(await fn());
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy('');
    }
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
        <div className="setting-row">
          <div>
            <strong>Gemini reads replies</strong>
            <div className="small muted">
              {me.replyReading
                ? 'On. Each reply to an email sent from here gets a one-line summary and a suggested stage (“Wants a call Thursday” → Screening).'
                : 'Off. Lets Gemini read only the replies to emails sent from here, to summarise them and suggest the next stage. Needs Gmail read permission.'}
            </div>
          </div>
          {!me.replyReading && (
            <a className="button small" href="/auth/google?add=read">
              Turn on
            </a>
          )}
        </div>
        <div className="setting-row">
          <div>
            <strong>Interviews from Google Calendar</strong>
            <div className="small muted">
              {me.calendarSync
                ? `On. Matches events to companies by attendees and names${me.calendarSyncedAt ? `; last checked ${new Date(me.calendarSyncedAt).toLocaleString()}` : ''}. You get prep reminders and a thank-you prompt after each one.`
                : 'Off. Read-only access to your calendar events finds interviews automatically.'}
            </div>
          </div>
          {me.calendarSync ? (
            <button className="small" disabled={busy === 'cal'} onClick={() => run('cal', async () => `Matched ${(await api<{ matched: number }>('/api/calendar/sync', { method: 'POST', body: {} })).matched} events`)}>
              Sync now
            </button>
          ) : (
            <a className="button small" href="/auth/google?add=calendar">
              Turn on
            </a>
          )}
        </div>
      </section>

      <section className="card form">
        <h2>Follow-ups and sending</h2>
        <label className="check">
          <input type="checkbox" checked={sequenceByDefault} onChange={(e) => setSequenceByDefault(e.target.checked)} />
          Turn on automatic follow-ups for new emails by default
        </label>
        <div className="two" style={{ marginTop: 12 }}>
          <label>
            Follow up after (working days)
            <input value={sequenceDays} onChange={(e) => setSequenceDays(e.target.value)} placeholder="4, 9" />
          </label>
          <label>
            Daily sending limit (0 = none)
            <input type="number" min={0} max={500} value={dailyCap} onChange={(e) => setDailyCap(Number(e.target.value))} />
          </label>
        </div>
        <p className="small muted">
          Up to three follow-ups, each sent into the same thread unless someone replies. The daily limit counts every email you send from here, including
          automatic ones. Sending many emails at once from a personal Gmail can get it flagged. Today: {me.sentToday} sent.
        </p>
      </section>

      <section className="card form">
        <h2>Weekly digest</h2>
        <label className="check">
          <input type="checkbox" checked={weeklyDigest} onChange={(e) => setWeeklyDigest(e.target.checked)} />
          Email me a summary every Monday at 9:00
        </label>
        <label style={{ marginTop: 12 }}>
          Time zone
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button className="ghost small" disabled={!!busy} onClick={() => run('dp', async () => (setDigest(await api('/api/digest/preview')), 'Preview below'))}>
            Preview
          </button>
          <button className="small" disabled={!!busy} onClick={() => run('ds', async () => (await api('/api/digest/send', { method: 'POST', body: {} }), `Sent to ${me.email}`))}>
            Send it now
          </button>
        </div>
        {digest && (
          <div className="digest-preview">
            <strong>{digest.subject}</strong>
            <pre>{digest.markdown}</pre>
          </div>
        )}
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
          Adds a <strong>Save to Mailtrack</strong> button on job pages (LinkedIn, Greenhouse, Lever, Ashby, Wellfound, Workable and most careers pages) that
          captures the role, description, salary and posting age, and stops your own Gmail views counting as opens.
        </p>
        <p className="small muted">
          Install: <code>chrome://extensions</code> → Developer mode → Load unpacked → the <code>extension/</code> folder of the mailtrack repo. After an
          update, click the reload icon on the extension. Stay signed in here in the same Chrome profile.
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
