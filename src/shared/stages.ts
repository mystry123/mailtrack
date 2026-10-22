// Job-application pipeline, shared by the server (auto-advancing) and the UI (board columns).

export const OPEN_STAGES = ['wishlist', 'applied', 'reached_out', 'replied', 'screening', 'interviewing', 'offer'] as const;
export const CLOSED_STAGES = ['accepted', 'rejected', 'ghosted', 'withdrawn'] as const;
export const STAGES = [...OPEN_STAGES, ...CLOSED_STAGES] as const;

export type Stage = (typeof STAGES)[number];
export type OpenStage = (typeof OPEN_STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  wishlist: 'Wishlist',
  applied: 'Applied',
  reached_out: 'Reached out',
  replied: 'Replied',
  screening: 'Screening',
  interviewing: 'Interviewing',
  offer: 'Offer',
  accepted: 'Accepted',
  rejected: 'Rejected',
  ghosted: 'Ghosted',
  withdrawn: 'Withdrawn',
};

export const STAGE_HINT: Record<Stage, string> = {
  wishlist: 'Want to apply',
  applied: 'Applied through a form or portal',
  reached_out: 'Emailed or messaged someone',
  replied: 'They wrote back',
  screening: 'Recruiter or intro call',
  interviewing: 'Technical or onsite rounds',
  offer: 'Offer in hand',
  accepted: 'You said yes',
  rejected: 'They said no',
  ghosted: 'Went silent',
  withdrawn: 'You stepped away',
};

export const SOURCES = ['cold_email', 'referral', 'linkedin', 'careers_page', 'job_board', 'recruiter', 'other'] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<Source, string> = {
  cold_email: 'Cold email',
  referral: 'Referral',
  linkedin: 'LinkedIn',
  careers_page: 'Careers page',
  job_board: 'Job board',
  recruiter: 'Recruiter reached me',
  other: 'Other',
};

export const isOpenStage = (s: string): s is OpenStage => (OPEN_STAGES as readonly string[]).includes(s);

// Position in the forward pipeline; closed stages sit outside it.
export const stageRank = (s: string): number => (OPEN_STAGES as readonly string[]).indexOf(s);

// Stages that mean the hunt for this one has started (counts toward the weekly goal).
export const STARTED_STAGES: readonly Stage[] = ['applied', 'reached_out'];

// Furthest open stage an application ever reached, from its history.
export function furthestRank(history: ReadonlyArray<{ stage?: string | null }>, current: string): number {
  let best = stageRank(current);
  for (const h of history) best = Math.max(best, stageRank(h.stage ?? ''));
  if (current === 'accepted' || history.some((h) => h.stage === 'accepted')) best = Math.max(best, stageRank('offer'));
  return best;
}

// Adds working days (Mon-Fri) to a date.
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d;
}
