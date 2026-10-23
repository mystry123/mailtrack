// Pure text edits behind the Compose toolbar. Each takes the textarea value and
// selection and returns the new value plus the selection to restore.

export interface TextEdit {
  value: string;
  start: number;
  end: number;
}

// **x**, *x*, ++x++, ~~x~~, `x`. Toggles off when the selection is already wrapped.
export function wrap(value: string, start: number, end: number, marker: string, placeholder: string): TextEdit {
  const m = marker.length;
  if (value.slice(start - m, start) === marker && value.slice(end, end + m) === marker) {
    return { value: value.slice(0, start - m) + value.slice(start, end) + value.slice(end + m), start: start - m, end: end - m };
  }
  const selected = value.slice(start, end);
  // Keep surrounding spaces outside the markers: "** bold **" isn't bold in markdown.
  const lead = selected.match(/^\s*/)![0];
  const trail = selected.slice(lead.length).match(/\s*$/)![0];
  const core = selected.slice(lead.length, selected.length - trail.length) || placeholder;
  const before = value.slice(0, start) + lead + marker;
  return {
    value: before + core + marker + trail + value.slice(end),
    start: before.length,
    end: before.length + core.length,
  };
}

// "- ", "1. ", "> ", "## " at the start of every selected line. Toggles off when all have it.
export function prefixLines(value: string, start: number, end: number, kind: 'bullet' | 'number' | 'quote' | 'heading'): TextEdit {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const nl = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
  const lineEnd = nl === -1 ? value.length : nl;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  const pattern = { bullet: /^- /, number: /^\d+\. /, quote: /^> /, heading: /^#{1,3} / }[kind];
  const all = lines.every((l) => pattern.test(l) || l.trim() === '');
  const next = lines.map((l, i) => {
    if (l.trim() === '' && lines.length > 1) return l;
    if (all) return l.replace(pattern, '');
    const bare = l.replace(/^(- |\d+\. |> |#{1,3} )/, '');
    return { bullet: '- ', number: `${i + 1}. `, quote: '> ', heading: '## ' }[kind] + bare;
  });
  const block = next.join('\n');
  return { value: value.slice(0, lineStart) + block + value.slice(lineEnd), start: lineStart, end: lineStart + block.length };
}

export function link(value: string, start: number, end: number): TextEdit {
  const selected = value.slice(start, end).trim();
  if (/^https?:\/\/\S+$/.test(selected)) {
    const before = value.slice(0, start) + '[';
    return { value: before + 'link text](' + selected + ')' + value.slice(end), start: before.length, end: before.length + 9 };
  }
  const label = selected || 'link text';
  const before = value.slice(0, start) + '[' + label + '](';
  return { value: before + 'https://)' + value.slice(end), start: before.length, end: before.length + 8 };
}

// Inserts a block (divider, snippet) on its own lines.
export function insertBlock(value: string, start: number, end: number, block: string): TextEdit {
  const before = value.slice(0, start).replace(/\s*$/, '');
  const after = value.slice(end).replace(/^\s*/, '');
  const head = before ? before + '\n\n' : '';
  const out = head + block + (after ? '\n\n' + after : '\n\n');
  const caret = head.length + block.length + 2;
  return { value: out, start: Math.min(caret, out.length), end: Math.min(caret, out.length) };
}

export function insertText(value: string, start: number, end: number, text: string): TextEdit {
  const out = value.slice(0, start) + text + value.slice(end);
  return { value: out, start: start + text.length, end: start + text.length };
}

const SIGN_OFF = /^(thanks|thank you|best|regards|cheers|warmly|sincerely)\b/i;

// Puts this resume link in the email: swaps any of your other resume links for
// it, or adds a "Resume:" line above the sign-off (or at the end).
export function swapResume(body: string, resumeUrls: string[], url: string): string {
  const present = resumeUrls.filter((u) => u !== url && body.includes(u));
  if (present.length) return present.reduce((b, u) => b.split(u).join(url), body);
  if (body.includes(url)) return body;
  const line = `**Resume:** [View Resume](${url})`;
  const lines = body.replace(/\s+$/, '').split('\n');
  let at = lines.length - 1;
  while (at >= 0 && !SIGN_OFF.test(lines[at].trim())) at--;
  if (at <= 0) return `${lines.join('\n')}${lines.join('').trim() ? '\n\n' : ''}${line}`;
  return [...lines.slice(0, at), ...(lines[at - 1].trim() ? [''] : []), line, '', ...lines.slice(at)].join('\n');
}
