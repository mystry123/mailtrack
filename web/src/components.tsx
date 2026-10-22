import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { STAGE_LABEL, type Stage } from '../../src/shared/stages';
import { api, type Application } from './api';

export function useApi<T>(path: string | null, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    if (!path) return;
    api<T>(path)
      .then((d) => (setData(d), setError('')))
      .catch((e) => setError(e.message));
  }, [path]);
  useEffect(() => {
    load();
    if (!refreshMs) return;
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);
  return { data, error, reload: load, setData };
}

export function StageBadge({ stage }: { stage: Stage }) {
  return <span className={`stage stage-${stage}`}>{STAGE_LABEL[stage]}</span>;
}

// Company initial on a colour derived from the name, so a company always looks the same.
export function Logo({ name, size = 32 }: { name: string; size?: number }) {
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="logo" style={{ width: size, height: size, fontSize: size * 0.42, ['--h' as string]: h }} aria-hidden>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function Stars({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  return (
    <span className="stars" aria-label={`Priority ${value} of 3`}>
      {[1, 2, 3].map((n) =>
        onChange ? (
          <button key={n} type="button" className={n <= value ? 'star on' : 'star'} onClick={() => onChange(n)} aria-label={`Priority ${n}`}>
            ★
          </button>
        ) : (
          <span key={n} className={n <= value ? 'star on' : 'star'}>
            ★
          </span>
        ),
      )}
    </span>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>
        {icon}
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export type PickedApp = { applicationId?: string; newApplication?: { company: string; role: string } };

// Pick an existing application or type a new company; a new one is created when the email goes out.
export function AppPicker({
  value,
  onChange,
  apps,
}: {
  value: PickedApp;
  onChange: (v: PickedApp & { label: string }) => void;
  apps: Application[];
}) {
  const current = value.applicationId ? apps.find((a) => a._id === value.applicationId) : undefined;
  const [text, setText] = useState(current?.company ?? value.newApplication?.company ?? '');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (current) setText(current.company);
  }, [current]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const q = text.trim().toLowerCase();
  const matches = apps.filter((a) => !q || a.company.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)).slice(0, 8);
  const exact = apps.find((a) => a.company.toLowerCase() === q);

  return (
    <div className="picker" ref={box}>
      <input
        value={text}
        placeholder="e.g. Cardboard"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          setOpen(true);
          const hit = apps.find((a) => a.company.toLowerCase() === t.trim().toLowerCase());
          onChange(
            hit
              ? { applicationId: hit._id, label: hit.company }
              : t.trim()
                ? { newApplication: { company: t.trim(), role: '' }, label: t.trim() }
                : { label: '' },
          );
        }}
      />
      {current && <span className="picker-tag">{current.role || 'linked'}</span>}
      {!current && q && !exact && <span className="picker-tag new">new</span>}
      {open && matches.length > 0 && (
        <div className="picker-menu">
          {matches.map((a) => (
            <button
              key={a._id}
              type="button"
              className="picker-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText(a.company);
                setOpen(false);
                onChange({ applicationId: a._id, label: a.company });
              }}
            >
              <Logo name={a.company} size={22} />
              <span className="picker-main">
                <strong>{a.company}</strong>
                <span className="muted small">{a.role || '—'}</span>
              </span>
              <StageBadge stage={a.stage} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}

// Emails sent before the pipeline existed (or without a company picked): offer to file them in one click.
export function ImportBanner({ onDone }: { onDone: (msg: string) => void }) {
  const { data, reload } = useApi<{ emails: number; companies: string[] }>('/api/applications/unlinked');
  const [busy, setBusy] = useState(false);
  if (!data || data.emails === 0) return null;
  const names = data.companies.slice(0, 3).join(', ') + (data.companies.length > 3 ? ` and ${data.companies.length - 3} more` : '');
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ created: number; linked: number }>('/api/applications/import', { method: 'POST', body: {} });
      onDone(`Added ${r.created} compan${r.created === 1 ? 'y' : 'ies'} · ${r.linked} email${r.linked === 1 ? '' : 's'} linked`);
      reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="banner import">
      <span>
        <strong>
          {data.emails} sent email{data.emails === 1 ? '' : 's'}
        </strong>{' '}
        to {names} {data.emails === 1 ? "isn't" : "aren't"} on your board yet.
      </span>
      <span className="banner-actions">
        <button className="small primary" onClick={run} disabled={busy}>
          {busy ? 'Adding…' : 'Add to pipeline'}
        </button>
      </span>
    </div>
  );
}
