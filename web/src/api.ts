export type Signal = 'real' | 'self' | 'auto' | 'bot';

export interface Recipient {
  email: string;
  name?: string;
}

export interface TrackedLink {
  token: string;
  url: string;
  label: string;
  clicks: number;
}

export interface Stats {
  opens: number;
  clicks: number;
  autoOpens: number;
  botClicks: number;
  firstOpenAt?: string;
  lastOpenAt?: string;
  firstClickAt?: string;
  lastClickAt?: string;
  lastActivityAt?: string;
}

export interface Message {
  _id: string;
  kind: 'email' | 'link';
  label: string;
  to: Recipient[];
  cc: Recipient[];
  subject: string;
  body?: string;
  html?: string;
  links: TrackedLink[];
  sentAt: string;
  stats: Stats;
  archived: boolean;
}

export interface TrackEvent {
  _id: string;
  type: 'open' | 'click';
  linkToken?: string;
  at: string;
  ip?: string;
  ua?: string;
  country?: string;
  region?: string;
  city?: string;
  source: string;
  signal: Signal;
  reason?: string;
  manual: boolean;
}

export interface Me {
  email: string;
  name: string;
  fromName: string;
  needsReauth: boolean;
  publicUrl: string;
}

export interface SavedLink {
  label: string;
  url: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message ?? (data.issues ? data.issues.join('; ') : data.error) ?? res.statusText;
    throw new ApiError(res.status, data.error ?? 'error', msg);
  }
  return data as T;
}
