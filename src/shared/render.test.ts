import { describe, expect, it } from 'vitest';
import { renderBody } from './render.js';

describe('renderBody', () => {
  it('maps labelled and bare links, keeping order', () => {
    const r = renderBody(
      'Hi,\n\nMy [Resume](https://drive.google.com/file/d/abc/view) and demo https://shotline.in/demo.',
      (_l, i) => `https://t/l/${i}`,
    );
    expect(r.links).toEqual([
      { url: 'https://drive.google.com/file/d/abc/view', label: 'Resume' },
      { url: 'https://shotline.in/demo', label: 'shotline.in/demo' },
    ]);
    expect(r.html).toContain('<a href="https://t/l/0">Resume</a>');
    // Trailing sentence punctuation is not part of the URL.
    expect(r.html).toContain('<a href="https://t/l/1">https://shotline.in/demo</a>.');
    expect(r.text).toContain('Resume (https://t/l/0)');
    expect(r.text).toContain('demo https://t/l/1.');
  });

  it('escapes HTML and keeps line breaks', () => {
    const r = renderBody('a <b>x</b>\nline two\n\n**bold**');
    expect(r.html).toContain('a &lt;b&gt;x&lt;/b&gt;<br>line two');
    expect(r.html).toContain('<strong>bold</strong>');
    expect(r.links).toEqual([]);
  });

  it('does not allow javascript: links', () => {
    const r = renderBody('[x](javascript:alert(1))');
    expect(r.links).toEqual([]);
    expect(r.html).not.toContain('<a ');
  });
});
