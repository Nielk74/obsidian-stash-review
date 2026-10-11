import {describe, expect, it} from 'vitest';
import {changeRanges, markChangedText} from '../src/ui/word-diff';
import {highlightedLines} from '../src/ui/format';

describe('inline changes in syntax-highlighted diffs', () => {
  it('emphasizes the changed expression while preserving unchanged context', () => {
    const before = 'const result = capture(text);';
    const after = 'const result = capture(trimmed);';
    const range = changeRanges(before, after)!;
    expect(before.slice(range.old.start, range.old.end)).toBe('text');
    expect(after.slice(range.next.start, range.next.end)).toBe('trimmed');
    const marked = markChangedText(highlightedLines(after, 'capture.ts')[0], range.next);
    expect(marked).toContain('<mark class="sr-inline-change">trimmed</mark>');
    expect(marked).toContain('hljs-keyword');
    expect(marked.replace(/<[^>]*>/g, '')).toBe(after);
  });
  it('keeps entities and nested syntax spans valid across a changed region', () => {
    const source = '<span class="hljs-string">&quot;&lt;img&gt;&quot;</span>';
    const marked = markChangedText(source, {start: 1, end: 6});
    expect(marked).toBe('<span class="hljs-string">&quot;<mark class="sr-inline-change">&lt;</mark><mark class="sr-inline-change">img</mark><mark class="sr-inline-change">&gt;</mark>&quot;</span>');
    expect(marked).not.toContain('<img>');
  });
  it('does not split Unicode characters or highlight CRLF-only differences', () => {
    const ranges = changeRanges('value = "🧠";', 'value = "🧡";')!;
    expect('value = "🧠";'.slice(ranges.old.start, ranges.old.end)).toBe('🧠');
    expect('value = "🧡";'.slice(ranges.next.start, ranges.next.end)).toBe('🧡');
    expect(changeRanges('unchanged\r', 'unchanged')).toBeNull();
  });
  it('handles inserted or removed suffixes without marking empty old regions', () => {
    const ranges = changeRanges('result', 'result.value')!;
    expect(ranges.old).toEqual({start: 6, end: 6});
    expect(markChangedText('result', ranges.old)).toBe('result');
    expect(markChangedText('result.value', ranges.next)).toBe('result<mark class="sr-inline-change">.value</mark>');
  });
});
