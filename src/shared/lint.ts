// Pre-send checks for a one-to-one job-search email. Shown live in Compose;
// "error" means almost certainly a mistake (asks you to confirm), "warn" is advice.

export interface LintIssue {
  level: 'error' | 'warn';
  message: string;
}

export interface LintInput {
  subject: string;
  body: string;
  // First recipient's name and the company, when known.
  recipientName?: string;
  company?: string;
}

const PLACEHOLDER = /\[(?:first\s*name|name|company|role|position|your name|recipient|x+)\]|\{\{[^}]*\}\}|<(?:name|company)>|\bXXX+\b/i;
const SPAM = /\b(guarantee[ds]?|100% free|act now|urgent(?:ly)?|risk[- ]free|click here|limited time|winner|\$\$\$)\b|!{3,}/i;
const LINK = /\[[^\]]+\]\(https?:\/\/[^)]+\)|https?:\/\/\S+/g;

export function lintEmail(input: LintInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const body = input.body.trim();
  const subject = input.subject.trim();

  const ph = (subject + '\n' + body).match(PLACEHOLDER);
  if (ph) issues.push({ level: 'error', message: `Placeholder left in: “${ph[0]}”` });

  if (!subject) issues.push({ level: 'error', message: 'No subject' });
  else {
    if (subject.length > 80) issues.push({ level: 'warn', message: 'Subject is long; under ~60 characters reads better on phones' });
    if (subject.length > 8 && subject === subject.toUpperCase()) issues.push({ level: 'warn', message: 'Subject is all caps' });
  }

  const spam = (subject + ' ' + body).match(SPAM);
  if (spam) issues.push({ level: 'warn', message: `“${spam[0]}” reads like spam to filters and people` });

  const links = body.match(LINK) ?? [];
  if (links.length > 4) issues.push({ level: 'warn', message: `${links.length} links: more than 3–4 looks like a newsletter` });
  if (/\[(?:here|this|link|click here)\]\(/i.test(body)) issues.push({ level: 'warn', message: 'Name links by what they are (“my resume”), not “here”' });

  const words = body.replace(LINK, ' link ').split(/\s+/).filter(Boolean).length;
  if (words > 220) issues.push({ level: 'warn', message: `${words} words: short cold emails (under ~150) get more replies` });

  if (/\battach(ed|ment)\b/i.test(body) && links.length === 0) {
    issues.push({ level: 'error', message: 'Mentions an attachment, but nothing is attached: link your resume instead' });
  }

  const first = input.recipientName?.trim().split(/\s+/)[0];
  const lower = body.toLowerCase();
  if (body && first && first.length > 1 && !lower.includes(first.toLowerCase()) && !(input.company && lower.includes(input.company.toLowerCase()))) {
    issues.push({ level: 'warn', message: `Doesn’t mention ${first} or the company: personal emails get more replies` });
  }
  return issues;
}
