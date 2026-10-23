// Turns the compose box's markdown into an HTML + plain-text email.
//
// Markdown (GFM, single newlines kept as line breaks) plus ++underline++.
// Raw HTML is shown as text, never rendered. Every element carries inline
// styles because many mail clients drop <style> blocks. Each http(s) link goes
// through `mapUrl`, which is where the sender swaps in a tracked redirect; the
// preview passes the URL through untouched. mailto: links stay as they are;
// any other scheme (javascript:, data:, ...) renders as plain text.

import { Marked, type Token, type Tokens, type TokenizerAndRendererExtension } from 'marked';

export interface FoundLink {
  url: string;
  label: string;
}

export interface Rendered {
  html: string;
  text: string;
  links: FoundLink[];
}

// Google Drive / Docs links (resumes) are sent as they are, never through the click redirect.
export const isDirectLink = (url: string) => /^https?:\/\/(drive|docs)\.google\.com\//i.test(url);

export type MapUrl = (link: FoundLink, index: number) => string;

type LinkToken = (Tokens.Link | Tokens.Image) & { mappedHref?: string; plainOnly?: boolean };

const S = {
  wrap: 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222',
  p: 'margin:0 0 1em 0',
  h1: 'font-size:22px;line-height:1.3;margin:0 0 0.6em 0',
  h2: 'font-size:18px;line-height:1.3;margin:0 0 0.6em 0',
  h3: 'font-size:15px;line-height:1.3;margin:0 0 0.5em 0',
  list: 'margin:0 0 1em 0;padding-left:24px',
  li: 'margin:0 0 4px 0',
  quote: 'margin:0 0 1em 0;padding:0 0 0 12px;border-left:3px solid #d0d4da;color:#555',
  code: 'font-family:Menlo,Consolas,monospace;font-size:13px;background:#f2f3f5;padding:1px 4px;border-radius:3px',
  pre: 'font-family:Menlo,Consolas,monospace;font-size:13px;background:#f2f3f5;padding:10px 12px;border-radius:6px;margin:0 0 1em 0;white-space:pre-wrap',
  hr: 'border:0;border-top:1px solid #e3e5e8;margin:1.2em 0',
  a: 'color:#1a56db',
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A readable name for a pasted URL; the dashboard reports clicks by it.
const KNOWN_HOSTS: [RegExp, string][] = [
  [/^drive\.google\.com$/, 'Google Drive file'],
  [/^docs\.google\.com$/, 'Google Doc'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
  [/^github\.com$/, 'GitHub'],
  [/(^|\.)notion\.(so|site)$/, 'Notion page'],
  [/^(www\.)?loom\.com$/, 'Loom video'],
  [/^(www\.)?youtube\.com$|^youtu\.be$/, 'YouTube video'],
];

export function labelForBareUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const known = KNOWN_HOSTS.find(([rx]) => rx.test(host));
    if (known) return known[1];
    const path = u.pathname.replace(/\/$/, '');
    return path && path.length <= 24 ? host + path : host;
  } catch {
    return url;
  }
}

const underline: TokenizerAndRendererExtension = {
  name: 'underline',
  level: 'inline',
  start: (src) => src.indexOf('++'),
  tokenizer(src) {
    const m = /^\+\+(?=\S)([\s\S]*?\S)\+\+/.exec(src);
    if (m) return { type: 'underline', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
    return undefined;
  },
  renderer(token) {
    return `<u>${this.parser.parseInline(token.tokens ?? [])}</u>`;
  },
};

function makeMarked(): Marked {
  return new Marked({
    gfm: true,
    breaks: true,
    extensions: [underline],
    renderer: {
      paragraph({ tokens }) {
        return `<p style="${S.p}">${this.parser.parseInline(tokens)}</p>`;
      },
      heading({ tokens, depth }) {
        const level = Math.min(depth, 3) as 1 | 2 | 3;
        return `<h${level} style="${S[`h${level}`]}">${this.parser.parseInline(tokens)}</h${level}>`;
      },
      list(token) {
        const tag = token.ordered ? 'ol' : 'ul';
        const start = token.ordered && token.start !== 1 && token.start !== '' ? ` start="${Number(token.start)}"` : '';
        const items = token.items.map((item) => this.listitem(item)).join('');
        return `<${tag}${start} style="${S.list}">${items}</${tag}>`;
      },
      listitem(item) {
        return `<li style="${S.li}">${this.parser.parse(item.tokens, !!item.loose)}</li>`;
      },
      blockquote({ tokens }) {
        return `<blockquote style="${S.quote}">${this.parser.parse(tokens)}</blockquote>`;
      },
      code({ text }) {
        return `<pre style="${S.pre}">${escapeHtml(text)}</pre>`;
      },
      codespan({ text }) {
        // marked 15 leaves code spans unescaped.
        return `<code style="${S.code}">${escapeHtml(decodeEntities(text))}</code>`;
      },
      hr() {
        return `<hr style="${S.hr}">`;
      },
      strong({ tokens }) {
        return `<strong>${this.parser.parseInline(tokens)}</strong>`;
      },
      em({ tokens }) {
        return `<em>${this.parser.parseInline(tokens)}</em>`;
      },
      del({ tokens }) {
        return `<s>${this.parser.parseInline(tokens)}</s>`;
      },
      link(token) {
        const t = token as LinkToken;
        const inner = this.parser.parseInline(token.tokens);
        if (t.plainOnly || !t.mappedHref) return inner;
        return `<a href="${escapeHtml(t.mappedHref)}" style="${S.a}">${inner}</a>`;
      },
      image(token) {
        // Shown as a link: embedded images trip spam filters and Gmail's proxy anyway.
        const t = token as LinkToken;
        const label = escapeHtml(token.text || labelForBareUrl(token.href));
        if (t.plainOnly || !t.mappedHref) return label;
        return `<a href="${escapeHtml(t.mappedHref)}" style="${S.a}">${label}</a>`;
      },
      html({ text }) {
        return escapeHtml(text);
      },
    },
  });
}

function plainText(tokens: Token[]): string {
  let out = '';
  for (const raw of tokens) {
    const t = raw as Token & { tokens?: Token[]; text?: string };
    switch (t.type) {
      case 'paragraph':
      case 'heading':
        out += plainText(t.tokens ?? []) + '\n\n';
        break;
      case 'list': {
        const list = t as Tokens.List;
        const first = list.ordered && list.start !== '' ? Number(list.start) : 1;
        list.items.forEach((item, i) => {
          const body = plainText(item.tokens).trim().replace(/\n/g, '\n   ');
          out += `${list.ordered ? `${first + i}.` : '-'} ${body}\n`;
        });
        out += '\n';
        break;
      }
      case 'blockquote':
        out += plainText(t.tokens ?? []).trim().replace(/^/gm, '> ') + '\n\n';
        break;
      case 'code':
        out += (t.text ?? '') + '\n\n';
        break;
      case 'hr':
        out += '----------\n\n';
        break;
      case 'space':
        break;
      case 'br':
        out += '\n';
        break;
      case 'link':
      case 'image': {
        const l = t as LinkToken;
        const label = l.type === 'link' ? plainText(l.tokens) : l.text;
        if (l.plainOnly || !l.mappedHref) out += label;
        else if (label === l.href || !label) out += l.mappedHref;
        else out += `${label} (${l.mappedHref})`;
        break;
      }
      case 'codespan':
        out += decodeEntities(t.text ?? '');
        break;
      case 'html':
        out += t.text ?? '';
        break;
      default:
        out += t.tokens ? plainText(t.tokens) : decodeEntities(t.text ?? '');
    }
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);
}

export function renderBody(body: string, mapUrl: MapUrl = (l) => l.url): Rendered {
  const marked = makeMarked();
  const tokens = marked.lexer(body.replace(/\r\n/g, '\n').trim());
  const links: FoundLink[] = [];

  marked.walkTokens(tokens, (token) => {
    if (token.type !== 'link' && token.type !== 'image') return;
    const t = token as LinkToken;
    const href = t.href.trim();
    if (/^mailto:/i.test(href)) {
      t.mappedHref = href;
    } else if (/^https?:\/\//i.test(href)) {
      const isBare = t.type === 'link' && (t.text === t.href || t.raw === t.href);
      const label = isBare || !t.text ? labelForBareUrl(href) : t.text;
      const link = { url: href, label };
      t.mappedHref = mapUrl(link, links.length);
      links.push(link);
    } else {
      t.plainOnly = true;
    }
  });

  const html = `<div style="${S.wrap}">${marked.parser(tokens)}</div>`;
  const text = plainText(tokens).replace(/\n{3,}/g, '\n\n').trim();
  return { html, text, links };
}

// Appends a signature (also markdown) under a "-- " separator line.
export function withSignature(body: string, signature: string | undefined): string {
  const sig = signature?.trim();
  return sig ? `${body.trimEnd()}\n\n--\n${sig}` : body;
}
