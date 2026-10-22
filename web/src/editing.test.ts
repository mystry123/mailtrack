import { describe, expect, it } from 'vitest';
import { insertBlock, link, prefixLines, wrap } from './editing';

describe('toolbar edits', () => {
  it('wraps and unwraps a selection', () => {
    const on = wrap('say hello now', 4, 9, '**', 'bold');
    expect(on).toEqual({ value: 'say **hello** now', start: 6, end: 11 });
    expect(wrap(on.value, on.start, on.end, '**', 'bold')).toEqual({ value: 'say hello now', start: 4, end: 9 });
  });

  it('keeps spaces outside the markers and uses a placeholder', () => {
    expect(wrap('a hi b', 1, 5, '*', 'x').value).toBe('a *hi* b');
    const empty = wrap('ab', 1, 1, '++', 'underlined');
    expect(empty.value).toBe('a++underlined++b');
    expect(empty.value.slice(empty.start, empty.end)).toBe('underlined');
  });

  it('prefixes and numbers lines, then toggles off', () => {
    const v = 'intro\none\ntwo\nend';
    const list = prefixLines(v, 7, 13, 'number');
    expect(list.value).toBe('intro\n1. one\n2. two\nend');
    expect(prefixLines(list.value, list.start, list.end, 'number').value).toBe(v);
    expect(prefixLines('x', 0, 0, 'bullet').value).toBe('- x');
  });

  it('builds links around text or a pasted URL', () => {
    const a = link('see resume', 4, 10);
    expect(a.value).toBe('see [resume](https://)');
    expect(a.value.slice(a.start, a.end)).toBe('https://');
    const b = link('https://x.co', 0, 12);
    expect(b.value).toBe('[link text](https://x.co)');
    expect(b.value.slice(b.start, b.end)).toBe('link text');
  });

  it('inserts a block on its own lines', () => {
    expect(insertBlock('above\nbelow', 5, 5, '---').value).toBe('above\n\n---\n\nbelow');
  });
});
