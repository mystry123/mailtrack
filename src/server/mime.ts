// Builds the RFC 5322 message handed to Gmail's users.messages.send.

export interface Address {
  email: string;
  name?: string;
}

export interface MimeInput {
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  html: string;
}

// Header values come from user input; never let them start a new header.
function clean(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

function encodeWord(s: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

export function formatAddress(a: Address): string {
  const email = clean(a.email);
  const name = a.name ? clean(a.name).replace(/["\\]/g, '') : '';
  return name ? `"${encodeWord(name)}" <${email}>` : email;
}

function base64Lines(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
}

export function buildMime(m: MimeInput, boundary: string): string {
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeWord(clean(m.subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset="UTF-8"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(body),
    ].join('\r\n');

  return [headers.join('\r\n'), '', part('text/plain', m.text), part('text/html', m.html), `--${boundary}--`, ''].join(
    '\r\n',
  );
}
