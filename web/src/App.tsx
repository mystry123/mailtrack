import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { Icon } from './icons';
import { ApplicationView } from './views/ApplicationView';
import { Board } from './views/Board';
import { Compose } from './views/Compose';
import { Detail } from './views/Detail';
import { InsightsView } from './views/Insights';
import { List } from './views/List';
import { Login } from './views/Login';
import { QuickLink } from './views/QuickLink';
import { Settings } from './views/Settings';
import { TodayView } from './views/Today';

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash.slice(1) || '/');
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

const NAV = [
  { to: '/', label: 'Today', icon: 'today' },
  { to: '/pipeline', label: 'Pipeline', icon: 'pipeline' },
  { to: '/sent', label: 'Sent', icon: 'sent' },
  { to: '/insights', label: 'Insights', icon: 'insights' },
];

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

  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);

  if (me === undefined) {
    return (
      <div className="login">
        {bootError && (
          <p className="error">
            {bootError}{' '}
            <button className="ghost" onClick={loadMe}>
              Retry
            </button>
          </p>
        )}
      </div>
    );
  }
  if (me === null || path === '/login') return <Login error={params.get('error')} />;

  let view;
  let section = path;
  const msg = path.match(/^\/m\/([a-f0-9]{24})$/);
  const app = path.match(/^\/a\/([a-f0-9]{24})$/);
  if (msg) {
    view = <Detail id={msg[1]} />;
    section = '/sent';
  } else if (app) {
    view = <ApplicationView id={app[1]} />;
    section = '/pipeline';
  } else if (path === '/pipeline') view = <Board />;
  else if (path === '/sent') view = <List />;
  else if (path === '/insights') view = <InsightsView />;
  else if (path === '/compose') view = <Compose key={query} me={me} params={params} />;
  else if (path === '/link') view = <QuickLink params={params} />;
  else if (path === '/settings') view = <Settings me={me} onSaved={loadMe} />;
  else {
    view = <TodayView me={me} />;
    section = '/';
  }

  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    setMe(null);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <a href="#/" className="brand">
          <span className="brand-mark" aria-hidden>
            <Icon name="sent" size={15} />
          </span>
          Mailtrack
        </a>
        <a href="#/compose" className="button primary new-btn">
          <Icon name="pen" size={16} /> New email
        </a>
        <nav className="nav">
          {NAV.map((n) => (
            <a key={n.to} href={`#${n.to}`} className={section === n.to ? 'nav-item active' : 'nav-item'}>
              <Icon name={n.icon} /> <span>{n.label}</span>
            </a>
          ))}
          <a href="#/link" className={section === '/link' ? 'nav-item active' : 'nav-item'}>
            <Icon name="link" /> <span>Tracked link</span>
          </a>
        </nav>
        <div className="sidebar-foot">
          <a href="#/settings" className={section === '/settings' ? 'nav-item active' : 'nav-item'}>
            <Icon name="settings" /> <span>Settings</span>
          </a>
          <div className="me">
            <span className="me-email" title={me.email}>
              {me.email}
            </span>
            <button className="link-btn small" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <nav className="tabbar" aria-label="Sections">
        {NAV.map((n) => (
          <a key={n.to} href={`#${n.to}`} className={section === n.to ? 'tab-item active' : 'tab-item'}>
            <Icon name={n.icon} size={20} />
            <span>{n.label}</span>
          </a>
        ))}
        <a href="#/compose" className={section === '/compose' ? 'tab-item active' : 'tab-item'}>
          <Icon name="pen" size={20} />
          <span>Write</span>
        </a>
      </nav>

      <main className="main">
        {me.needsReauth && (
          <div className="banner warn">
            Gmail access has expired. <a href="/auth/google">Reconnect Google</a> to send again; tracking keeps working.
          </div>
        )}
        {!me.needsReauth && !me.replyDetection && (
          <div className="banner">
            Turn on reply detection: <a href="/auth/google">reconnect Google</a> and allow “View your email message metadata”. Mailtrack
            then sees who replied, never what they wrote.
          </div>
        )}
        {view}
      </main>
    </div>
  );
}
