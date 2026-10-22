import type { Source, Stage } from '../../src/shared/stages';

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
  replies?: number;
  firstReplyAt?: string;
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
  includeSignature?: boolean;
  applicationId?: string;
  followUpOf?: string;
  status?: 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled';
  automatic?: boolean;
  trackOpens?: boolean;
  sequence?: Sequence;
  scheduledAt?: string;
  sendError?: string;
  links: TrackedLink[];
  sentAt: string;
  stats: Stats;
  archived: boolean;
}

export interface TrackEvent {
  _id: string;
  messageId: string;
  type: 'open' | 'click' | 'reply';
  from?: string;
  summary?: string;
  suggestedStage?: string;
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
  isOwner: boolean;
  name: string;
  fromName: string;
  signature: string;
  aboutMe: string;
  weeklyGoal: number;
  followUpDays: number;
  replyDetection: boolean;
  replyReading: boolean;
  calendarSync: boolean;
  calendarSyncedAt?: string;
  sequenceDays: number[];
  sequenceByDefault: boolean;
  dailyCap: number;
  sentToday: number;
  timezone: string;
  weeklyDigest: boolean;
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

export interface EnhanceResult {
  subject: string;
  body: string;
  notes: string;
  model: string;
  warnings: string[];
}

export interface Contact {
  name: string;
  email: string;
  title: string;
  linkedin: string;
}

export interface Application {
  _id: string;
  company: string;
  role: string;
  jobUrl: string;
  jobDescription?: string;
  source: Source;
  stage: Stage;
  stageHistory: { stage: Stage; at: string }[];
  startedAt?: string;
  location: string;
  salary: string;
  priority: number;
  contacts: Contact[];
  notes?: { _id: string; text: string; at: string }[];
  interviewAt?: string | null;
  snoozedUntil?: string | null;
  interviews?: { eventId: string; title: string; start: string; end: string; attendees: string[]; matchedBy: string; thankYouDone: boolean }[];
  suggestion?: { stage?: Stage; reason?: string; at?: string };
  posting?: { postedAt?: string; reposted?: boolean; salary?: string; capturedAt?: string; source?: string };
  thankYous?: string[];
  brief?: { text?: string; sources?: { title: string; url: string }[]; at?: string };
  prep?: { _id?: string; text: string; done: boolean }[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  activity?: {
    emails: number;
    links: number;
    opens: number;
    clicks: number;
    replies: number;
    scheduled: number;
    lastSentAt?: string;
    lastActivityAt?: string;
  };
}

export interface AppSummary {
  _id: string;
  company: string;
  role: string;
  stage: Stage;
  priority: number;
  interviewAt?: string;
}

export interface MessageSummary {
  _id: string;
  subject: string;
  to: Recipient[];
  label: string;
  sentAt: string;
  stats: Stats;
  applicationId?: string;
  kind?: 'email' | 'link';
}

export interface SequenceStep {
  _id: string;
  afterDays: number;
  dueAt: string;
  status: 'pending' | 'sent' | 'skipped' | 'cancelled';
  subject: string;
  body: string;
  draftedAt?: string;
  edited: boolean;
  messageId?: string;
  error?: string;
}

export interface Sequence {
  status: 'active' | 'stopped' | 'done';
  stopReason?: string;
  steps: SequenceStep[];
}

export interface Person {
  _id: string;
  name: string;
  email: string;
  company: string;
  title: string;
  linkedin: string;
  relationship: 'referral' | 'recruiter' | 'hiring_manager' | 'founder' | 'friend' | 'other';
  notes: string;
  applicationIds: string[];
  lastContactAt?: string;
}

export const RELATIONSHIP_LABEL: Record<Person['relationship'], string> = {
  referral: 'Can refer me',
  recruiter: 'Recruiter',
  hiring_manager: 'Hiring manager',
  founder: 'Founder',
  friend: 'Friend / ex-colleague',
  other: 'Other',
};

export interface Today {
  goal: number;
  suggestions: { application: AppSummary; stage: Stage; reason: string; at: string }[];
  thankYous: { application: AppSummary; key: string; title: string; end: string }[];
  upcomingAuto: { message: MessageSummary; application?: AppSummary; step: number; dueAt: string; drafted: boolean }[];
  followUps: { application: AppSummary; message: MessageSummary; followUpNumber: number; daysSince: number }[];
  ghosted: { application: AppSummary; daysSince: number }[];
  hot: {
    message: MessageSummary;
    application?: AppSummary;
    opens: number;
    clicks: number;
    clickedLabels: string[];
    lastAt: string;
  }[];
  replies: { at: string; from?: string; summary?: string; message?: MessageSummary; application?: AppSummary }[];
  scheduled: { _id: string; subject: string; to: Recipient[]; label: string; scheduledAt?: string; status: string; sendError?: string }[];
  interviews: AppSummary[];
  stageCounts: Record<string, number>;
  started: string[];
  active: number;
}

export interface Insights {
  funnel: { stage: Stage; label: string; count: number }[];
  bySource: { source: Source; started: number; replied: number; interviewing: number }[];
  byTemplate: { name: string; sent: number; replied: number; clicked: number }[];
  byLink: { label: string; sent: number; replied: number; clicked: number; linkClicks: number }[];
  bySubject: { subject: string; sent: number; replied: number; clicked: number }[];
  sequences: { sent: number; replies: number };
  emails: { sent: number; opened: number; clicked: number; replied: number; followUps: number; avgReplyDays: number | null };
  engagement: { type: 'open' | 'click' | 'reply'; at: string }[];
  started: string[];
  closed: { rejected: number; ghosted: number; withdrawn: number; accepted: number };
}

export interface Template {
  _id: string;
  name: string;
  subject: string;
  body: string;
}

export interface Prefill {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  label?: string;
  applicationId?: string;
  followUpOf?: string;
  includeSignature?: boolean;
}

export interface FoundPeople {
  domain: string;
  mailOk: boolean;
  needDomain?: boolean;
  people: { name: string; title: string; emails: { email: string; confidence: 'verified' | 'likely' | 'possible'; why: string }[] }[];
  sources: { title: string; url: string }[];
}
