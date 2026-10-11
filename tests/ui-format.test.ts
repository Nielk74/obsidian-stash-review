import { describe, expect, it } from 'vitest';
import { fullContextLines, highlightedLines } from '../src/ui/format';
import { parseDiff } from '../src/git';

describe('review context and syntax', () => {
  it('expands separated hunks without losing or duplicating unchanged source lines', () => {
    const [file] = parseDiff('diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -2 +2,2 @@\n-two\n+TWO\n+extra\n@@ -5,2 +6 @@\n-five\n six\n');
    file.oldContent = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n';
    file.newContent = 'one\nTWO\nextra\nthree\nfour\nsix\nseven\n';
    const expanded = fullContextLines(file);
    expect(expanded.filter(line => line.newLine !== undefined).map(line => line.text).join('\n') + '\n').toBe(file.newContent);
    expect(expanded.filter(line => line.oldLine !== undefined).map(line => line.text).join('\n') + '\n').toBe(file.oldContent);
    expect(expanded.filter(line => line.newLine !== undefined).map(line => line.newLine)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('preserves line numbers for insertions at the beginning and removals at the end', () => {
    const [file] = parseDiff('diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -0,0 +1 @@\n+begin\n@@ -3 +3,0 @@\n-end\n');
    file.oldContent = 'middle\nother\nend\n';
    file.newContent = 'begin\nmiddle\nother\n';
    const expanded = fullContextLines(file);
    expect(expanded.filter(line => line.newLine !== undefined).map(line => line.text)).toEqual(['begin', 'middle', 'other']);
    expect(expanded.filter(line => line.oldLine !== undefined).map(line => line.text)).toEqual(['middle', 'other', 'end']);
  });
  it('carries multiline syntax tokens while keeping each line valid and source HTML escaped', () => {
    const lines = highlightedLines('/* first\nsecond */\nconst value = "<script>alert(1)</script>";', 'app.ts');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('hljs-comment');
    expect(lines[1]).toContain('hljs-comment');
    expect(lines[2]).toContain('hljs-keyword');
    expect(lines[2]).toContain('&lt;script&gt;');
    expect(lines[2]).not.toContain('<script>');
    for (const line of lines) expect((line.match(/<span /g) ?? []).length).toBe((line.match(/<\/span>/g) ?? []).length);
  });
  it('shows unsupported file types as escaped source', () => {
    expect(highlightedLines('<img src=x onerror="alert(1)">', 'file.unknown')[0]).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });
});
