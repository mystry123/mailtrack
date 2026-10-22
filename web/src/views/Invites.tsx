import { useState } from 'react';
import { api } from '../api';
import { useApi } from '../components';
import { ago } from '../format';

interface Invites {
  owner: string;
  invites: { _id: string; email: string; note: string; invitedAt: string; joinedAt: string | null }[];
}

// Owner only: who else can sign in. Each person connects their own Gmail and sees only their own data.
export function Invites({ onToast }: { onToast: (m: string) => void }) {
  const { data, reload } = useApi<Invites>('/api/invites');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const invite = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/invites', { method: 'POST', body: { email, note } });
      onToast(`Invited ${email}`);
      setEmail('');
      setNote('');
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, who: string) => {
    if (!window.confirm(`Remove ${who}? They won't be able to sign in; their data is kept.`)) return;
    await api(`/api/invites/${id}`, { method: 'DELETE' });
    onToast(`Removed ${who}`);
    reload();
  };

  const url = `${window.location.origin}/app/`;
  return (
    <section className="card form">
      <h2>Who can use Mailtrack</h2>
      <p className="small muted">
        Invite friends by their Gmail address. Each person signs in with Google at <code>{url}</code>, connects their own Gmail, and sees only their own
        emails, pipeline and people. Google allows up to 100 people while the app is unverified; they’ll see a “Google hasn’t verified this app” screen once
        (Advanced → Continue).
      </p>
      <div className="invite-row">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@gmail.com" onKeyDown={(e) => e.key === 'Enter' && email && invite()} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
        <button className="primary" onClick={invite} disabled={busy || !email.trim()}>
          Invite
        </button>
      </div>
      {error && <p className="small error">{error}</p>}
      <ul className="task-list">
        <li className="task">
          <div className="task-main">
            <strong>{data?.owner}</strong>
            <div className="small muted">Owner (you)</div>
          </div>
        </li>
        {data?.invites.map((i) => (
          <li key={i._id} className="task">
            <div className="task-main">
              <strong>{i.email}</strong>
              <div className="small muted">
                {i.joinedAt ? `Joined ${ago(i.joinedAt)}` : `Invited ${ago(i.invitedAt)}, hasn’t signed in yet`}
                {i.note ? ` · ${i.note}` : ''}
              </div>
            </div>
            <button className="ghost small" onClick={() => remove(i._id, i.email)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
