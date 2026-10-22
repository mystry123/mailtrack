// Test mode only (FAKE_GOOGLE / FAKE_AI, refused in production): Gmail,
// Calendar and Gemini replaced by deterministic fakes kept in the test
// database, so every flow can run end to end without touching real mail.
// Tests drive them by writing to the fake_* collections (e.g. a reply).

import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';

const col = (name: string) => mongoose.connection.db!.collection(name);
const id = () => randomBytes(8).toString('hex');

interface FakeThreadMessage {
  id: string;
  at: Date;
  from: string;
  fromEmail: string;
  sentByMe: boolean;
  text?: string;
}

export const fakeGoogle = {
  async send(m: { to: { email: string }[]; subject: string; threadId?: string }, raw: string) {
    const msgId = id();
    const threadId = m.threadId ?? id();
    await col('fake_outbox').insertOne({ id: msgId, threadId, to: m.to.map((t) => t.email), subject: m.subject, raw, at: new Date() });
    await col('fake_threads').updateOne(
      { threadId },
      { $push: { messages: { id: msgId, at: new Date(), from: 'me', fromEmail: 'me', sentByMe: true } } as never },
      { upsert: true },
    );
    return { id: msgId, threadId };
  },
  async rfcMessageId(gmailId: string) {
    return `<fake-${gmailId}@mail.gmail.com>`;
  },
  async thread(threadId: string) {
    const t = await col('fake_threads').findOne({ threadId });
    return ((t?.messages ?? []) as FakeThreadMessage[]).map((m) => ({ ...m, at: new Date(m.at) }));
  },
  async text(gmailId: string) {
    const t = await col('fake_threads').findOne({ 'messages.id': gmailId });
    return ((t?.messages ?? []) as FakeThreadMessage[]).find((m) => m.id === gmailId)?.text ?? '';
  },
  async events(from: Date, to: Date) {
    const rows = await col('fake_calendar').find({ start: { $gte: from, $lte: to } }).toArray();
    return rows.map((e) => ({
      id: String(e.id),
      title: String(e.title ?? ''),
      description: String(e.description ?? ''),
      start: new Date(e.start),
      end: new Date(e.end),
      attendees: (e.attendees ?? []) as string[],
    }));
  },
};

// Gemini stand-in: answers in the shape each caller asks for, echoing given
// links so link-preservation checks pass.
export function fakeAi(kind: string, prompt: string): string {
  const urls = prompt.match(/https?:\/\/[^\s)\]>]+/g) ?? [];
  const firstUrl = urls[0];
  switch (kind) {
    case 'email':
    case 'followup':
    case 'thankyou':
    case 'referral': {
      const subject = kind === 'followup' ? `Re: ${prompt.match(/Original subject: (.+)/)?.[1] ?? 'hello'}` : `Fake ${kind} subject`;
      const body = `Hi there,\n\nFake ${kind} body.${firstUrl ? ` See [my resume](${firstUrl}).` : ''}\n\nThanks`;
      return JSON.stringify({ subject, body, notes: `fake ${kind}` });
    }
    case 'reply': {
      const text = (prompt.split('Their reply:')[1] ?? '').toLowerCase();
      const stage = /unfortunately|not moving forward|other candidates/.test(text)
        ? 'rejected'
        : /interview|onsite|technical round/.test(text)
          ? 'interviewing'
          : /call|chat|schedule/.test(text)
            ? 'screening'
            : 'replied';
      return JSON.stringify({ summary: `Fake summary (${stage})`, suggestedStage: stage });
    }
    case 'prep':
      return JSON.stringify({ items: ['Fake prep item one', 'Fake prep item two', 'Fake prep item three'] });
    case 'people':
      return JSON.stringify({ people: [{ name: 'Jane Founder', title: 'CEO & Co-founder' }] });
    case 'brief':
      return '**What they do**\nFake brief.';
    default:
      return '{}';
  }
}
