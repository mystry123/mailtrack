import { describe, expect, it } from 'vitest';
import { isDirectLink, renderBody, withSignature } from './render.js';

const track = (_l: unknown, i: number) => `https://t/l/${i}`;

describe('renderBody', () => {
  it('maps labelled and bare links, keeping order', () => {
    const r = renderBody('Hi,\n\nMy [Resume](https://drive.google.com/file/d/abc/view) and demo https://shotline.in/demo.', track);
    expect(r.links).toEqual([
      { url: 'https://drive.google.com/file/d/abc/view', label: 'Resume' },
      { url: 'https://shotline.in/demo', label: 'shotline.in/demo' },
    ]);
    expect(r.html).toMatch(/<a href="https:\/\/t\/l\/0"[^>]*>Resume<\/a>/);
    // Trailing sentence punctuation is not part of the URL.
    expect(r.html).toMatch(/<a href="https:\/\/t\/l\/1"[^>]*>https:\/\/shotline.in\/demo<\/a>\./);
    expect(r.text).toContain('Resume (https://t/l/0)');
    expect(r.text).toContain('demo https://t/l/1.');
  });

  it('renders formatting', () => {
    const r = renderBody(
      '# Title\n\n**bold** *italic* ++under++ ~~gone~~ `x < y`\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n---\n\nend',
    );
    expect(r.html).toContain('<h1 ');
    expect(r.html).toContain('<strong>bold</strong>');
    expect(r.html).toContain('<em>italic</em>');
    expect(r.html).toContain('<u>under</u>');
    expect(r.html).toContain('<s>gone</s>');
    expect(r.html).toMatch(/<code [^>]*>x &lt; y<\/code>/);
    expect(r.html).toMatch(/<ul [^>]*><li [^>]*>one<\/li><li [^>]*>two<\/li><\/ul>/);
    expect(r.html).toContain('<ol ');
    expect(r.html).toContain('<blockquote ');
    expect(r.html).toContain('<hr ');
    expect(r.text).toContain('- one\n- two');
    expect(r.text).toContain('1. first\n2. second');
    expect(r.text).toContain('> quoted');
    expect(r.text).toContain('x < y');
    expect(r.text).not.toContain('**');
  });

  it('names pasted links readably', () => {
    const r = renderBody('https://drive.google.com/file/d/13LyT4ENv30FSC1jdLSZcWjZiv4W82km2/view and https://example.com/a/very/long/path/that/goes/on');
    expect(r.links.map((l) => l.label)).toEqual(['Google Drive file', 'example.com']);
  });

  it('keeps single newlines as line breaks', () => {
    const r = renderBody('Thanks,\nRitik');
    expect(r.html).toContain('Thanks,<br>Ritik');
    expect(r.text).toBe('Thanks,\nRitik');
  });

  it('never renders raw HTML', () => {
    const r = renderBody('a <b>x</b> <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(r.html).not.toMatch(/<script|<img|<b>/);
    // marked 15 leaves code spans unescaped; we must not.
    expect(renderBody('`<script>x</script>`').html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('drops unsafe link schemes and leaves mailto untracked', () => {
    const r = renderBody('[x](javascript:alert(1)) [mail](mailto:a@b.co)', track);
    expect(r.links).toEqual([]);
    expect(r.html).not.toContain('javascript:');
    expect(r.html).toContain('href="mailto:a@b.co"');
  });

  it('appends a signature', () => {
    const r = renderBody(withSignature('Hello', '**Ritik**\nshotline.in'));
    expect(r.html).toContain('<strong>Ritik</strong>');
    expect(withSignature('Hello', '  ')).toBe('Hello');
  });
});

describe('isDirectLink', () => {
  it('sends Google Drive and Docs links as they are', () => {
    expect(isDirectLink('https://drive.google.com/file/d/abc/view')).toBe(true);
    expect(isDirectLink('https://docs.google.com/document/d/abc/edit')).toBe(true);
    expect(isDirectLink('https://shotline.in')).toBe(false);
    expect(isDirectLink('https://drive.google.com.evil.example/x')).toBe(false);
  });
});
