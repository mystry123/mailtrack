// Your resume versions. Each is a Google Drive or Docs link that goes into
// emails as is; its text is read once so Gemini can pick the right one for a job.

import { extractText, getDocumentProxy } from 'unpdf';
import { chooseResume, type JobContext } from './ai.js';
import { env } from './env.js';
import { fakeGoogle } from './fakes.js';
import { logger } from './logger.js';
import { bestByKeywords } from '../shared/keywords.js';

export class ResumeUnreadable extends Error {}

const SHARING = 'Drive wouldn’t share it. In Drive: Share → General access → “Anyone with the link” (Viewer).';

export function driveFile(url: string): { kind: 'file' | 'doc'; id: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.hostname === 'docs.google.com') {
    const id = u.pathname.match(/^\/document\/d\/([\w-]{10,})/)?.[1];
    return id ? { kind: 'doc', id } : null;
  }
  if (u.hostname === 'drive.google.com') {
    const id = u.pathname.match(/^\/file\/d\/([\w-]{10,})/)?.[1] ?? u.searchParams.get('id');
    return id && /^[\w-]{10,}$/.test(id) ? { kind: 'file', id } : null;
  }
  return null;
}

const MAX_BYTES = 10 * 1024 * 1024;

async function download(url: string): Promise<{ type: string; bytes: Uint8Array }> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new ResumeUnreadable(SHARING);
  if (!res.ok) throw new ResumeUnreadable(`Google Drive answered ${res.status}. Try again in a minute.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new ResumeUnreadable('That file is over 10 MB.');
  return { type: res.headers.get('content-type') ?? '', bytes };
}

const tidy = (text: string) => text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20_000);

// The text of a resume behind a Drive (PDF) or Docs link.
export async function readResume(url: string): Promise<{ text: string; pages: number }> {
  const file = driveFile(url);
  if (!file) throw new ResumeUnreadable('Use a Google Drive file link (drive.google.com/file/d/…) or a Google Doc link.');
  if (env.FAKE_GOOGLE) return { text: await fakeGoogle.resumeText(url).catch(() => Promise.reject(new ResumeUnreadable(SHARING))), pages: 1 };

  if (file.kind === 'doc') {
    const { type, bytes } = await download(`https://docs.google.com/document/d/${file.id}/export?format=txt`);
    if (type.includes('text/html')) throw new ResumeUnreadable(SHARING);
    return { text: tidy(new TextDecoder().decode(bytes)), pages: 0 };
  }
  const { bytes } = await download(`https://drive.google.com/uc?export=download&id=${file.id}`);
  // A sign-in or "request access" page instead of the file.
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') {
    const head = new TextDecoder().decode(bytes.slice(0, 2000)).toLowerCase();
    throw new ResumeUnreadable(head.includes('<html') ? SHARING : 'Only PDF files (or Google Docs) can be read.');
  }
  try {
    const pdf = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    if (!text.trim()) throw new ResumeUnreadable('That PDF has no text (a scanned image?). Export it from your editor as a text PDF.');
    return { text: tidy(text), pages: totalPages };
  } catch (err) {
    if (err instanceof ResumeUnreadable) throw err;
    logger.warn({ err }, 'resume PDF unreadable');
    throw new ResumeUnreadable('Couldn’t read that PDF.');
  }
}

export interface Pick {
  resumeId: string;
  reason: string;
  // 'gemini', 'keywords' (Gemini unavailable) or 'only' (just one resume).
  by: 'gemini' | 'keywords' | 'only';
}

// The best of your resumes for this job.
export async function pickResume(job: JobContext, resumes: { _id: { toString(): string }; name: string; text: string }[]): Promise<Pick | null> {
  if (!resumes.length) return null;
  if (resumes.length === 1) return { resumeId: String(resumes[0]._id), reason: 'Your only resume', by: 'only' };
  try {
    const c = await chooseResume(job, resumes);
    return { resumeId: String(resumes[c.index]._id), reason: c.reason, by: 'gemini' };
  } catch (err) {
    logger.warn({ err }, 'Gemini resume pick failed; using keywords');
    const jobText = [job.role, job.jobDescription].filter(Boolean).join('\n');
    const { index, matched } = bestByKeywords(jobText, resumes);
    return { resumeId: String(resumes[index]._id), reason: matched.length ? `Mentions ${matched.join(', ')}` : 'Closest match', by: 'keywords' };
  }
}
