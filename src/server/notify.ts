import { env } from './env.js';
import { myEmail, sendGmail } from './google.js';
import { logger } from './logger.js';
import type { Message, TrackEvent } from './models.js';
import { renderBody } from '../shared/render.js';

function who(m: Message): string {
  if (m.kind === 'link') return m.label || 'Someone';
  const first = m.to[0];
  const name = first?.name || first?.email || 'Someone';
  return m.label ? `${name} (${m.label})` : name;
}

function where(e: TrackEvent): string {
  return [e.city, e.region, e.country].filter(Boolean).join(', ');
}

// Emails you (from you, to you) the first time a message gets a real open or
// click. Sent without tracking, and failures are only logged.
export async function notifyFirst(m: Message, e: TrackEvent): Promise<void> {
  if (e.type === 'click' && !env.NOTIFY_ON_CLICK) return;
  if (e.type === 'open' && !env.NOTIFY_ON_OPEN) return;

  const link = e.linkToken ? m.links.find((l) => l.token === e.linkToken) : undefined;
  const action = e.type === 'click' ? `clicked ${link?.label || 'your link'}` : 'opened your email';
  const subject = `${who(m)} ${action}`;
  const place = where(e);
  const body = [
    `${who(m)} ${action}${place ? ` from ${place}` : ''}.`,
    m.subject ? `Email: **${m.subject}**` : '',
    `${env.PUBLIC_URL}/app/#/m/${m._id}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const { html, text } = renderBody(body);

  try {
    await sendGmail({ to: [{ email: await myEmail() }], cc: [], subject, html, text });
  } catch (err) {
    logger.warn({ err, messageId: String(m._id) }, 'notification failed');
  }
}
