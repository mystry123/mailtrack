import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { Compose } from './views/Compose';
import { Detail } from './views/Detail';
import { List } from './views/List';
import { Login } from './views/Login';
import { QuickLink } from './views/QuickLink';
import { Settings } from './views/Settings';

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [bootError, setBootError] = useState('');

  const loadMe = useCallback(() => {
    api<Me>('/api/me')
      .then((m) => (setMe(m), setBootError('')))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setMe(null);
        else setBootError(err.message || 'Could not reach the server');
      });
  }, []);
  useEffect(loadMe, [loadMe]);

  const [path, query] = hash.split('?');

  if (me === undefined) {
    return (
      <div className="login">
        {bootError && (
          <p className="error">
            {bootError} <button className="ghost" onClick={loadMe}>Retry</button>
          </p>
        )}
      </div>
    );
  }
  if (me === null || path === '/login') {
    return <Login error={new URLSearchParams(query).get('error')} />;
  }

  let view;
  const detail = path.match(/^\/m\/([a-f0-9]{24})$/);
  if (detail) view = <Detail id={detail[1]} />;
  else if (path === '/compose') view = <Compose me={me} />;
  else if (path === '/link') view = <QuickLink />;
  else if (path === '/settings') view = <Settings me={me} onSaved={loadMe} />;
  else view = <List />;

  const tab = (to: string, label: string, active: boolean) => (
    <a href={`#${to}`} className={active ? 'tab active' : 'tab'}>
      {label}
    </a>
  );

  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    setMe(null);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="dot" /> Mailtrack
        </a>
        <nav>
          {tab('/', 'Sent', path === '/' || !!detail)}
          {tab('/compose', 'Compose', path === '/compose')}
          {tab('/link', 'Tracked link', path === '/link')}
          {tab('/settings', 'Settings', path === '/settings')}
        </nav>
        <div className="who">
          <span className="muted">{me.email}</span>
          <button className="ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      {me.needsReauth && (
        <div className="banner">
          Gmail access has expired. <a href="/auth/google">Reconnect Google</a> to send again; tracking keeps working.
        </div>
      )}
      <main>{view}</main>
    </div>
  );
}
