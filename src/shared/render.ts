// Turns the compose box's light markup into an HTML + plain-text email.
//
// Supported: blank-line paragraphs, single newlines as <br>, **bold**,
// [label](https://url) links and bare https:// URLs. Every link goes through
// `mapUrl`, which is where the sender swaps in a tracked redirect; the preview
// passes the URL through untouched.

export interface FoundLink {
  url: string;
  label: string;
}

export interface Rendered {
  html: string;
  text: string;
  links: FoundLink[];
}

export type MapUrl = (link: FoundLink, index: number) => string;

const TOKEN_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\*\*([^*\n]+)\*\*/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function labelForBareUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

export function renderBody(body: string, mapUrl: MapUrl = (l) => l.url): Rendered {
  const links: FoundLink[] = [];
  const paragraphs = body.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);

  const htmlParts: string[] = [];
  const textParts: string[] = [];

  for (const para of paragraphs) {
    let html = '';
    let text = '';
    let last = 0;
    for (const m of para.matchAll(TOKEN_RE)) {
      const before = para.slice(last, m.index);
      html += escapeHtml(before).replace(/\n/g, '<br>');
      text += before;
      last = m.index! + m[0].length;

      if (m[4] !== undefined) {
        html += `<strong>${escapeHtml(m[4])}</strong>`;
        text += m[4];
        continue;
      }

      const url = m[2] ?? m[3]!;
      const label = m[1] ?? labelForBareUrl(url);
      const link = { url, label };
      const href = mapUrl(link, links.length);
      links.push(link);
      html += `<a href="${escapeHtml(href)}">${escapeHtml(m[1] ?? url)}</a>`;
      text += m[1] ? `${m[1]} (${href})` : href;
    }
    const rest = para.slice(last);
    html += escapeHtml(rest).replace(/\n/g, '<br>');
    text += rest;

    htmlParts.push(`<p style="margin:0 0 1em 0">${html}</p>`);
    textParts.push(text);
  }

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">' +
    htmlParts.join('') +
    '</div>';

  return { html, text: textParts.join('\n\n'), links };
}
