import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/git';

describe('Git patch parsing', () => {
  it('tracks independent line numbers across replacements and multiple hunks', () => {
    const [file] = parseDiff(`diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -2,3 +2,4 @@ function example() {
 context
-before
+after
+extra
 end
@@ -30 +31 @@
-last old
+last new
\\ No newline at end of file
`);
    expect(file.path).toBe('example.ts');
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(2);
    expect(file.hunks[0].lines).toEqual([
      { type: 'context', text: 'context', oldLine: 2, newLine: 2 },
      { type: 'delete', text: 'before', oldLine: 3 },
      { type: 'add', text: 'after', newLine: 3 },
      { type: 'add', text: 'extra', newLine: 4 },
      { type: 'context', text: 'end', oldLine: 4, newLine: 5 }
    ]);
    expect(file.hunks[1].lines.at(-1)).toEqual({ type: 'info', text: '\\ No newline at end of file' });
    expect(file.hunks[1].oldCount).toBe(1);
  });

  it('supports zero-length hunk ranges in additions and deletions', () => {
    const files = parseDiff(`diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
`);
    expect(files[0].status).toBe('added');
    expect(files[0].hunks[0].oldCount).toBe(0);
    expect(files[1].status).toBe('deleted');
    expect(files[1].hunks[0].newCount).toBe(0);
    expect(files[1].hunks[0].lines[0].oldLine).toBe(1);
  });

  it('preserves whitespace, empty lines, and code resembling patch markers', () => {
    const [file] = parseDiff([
      'diff --git a/space.txt b/space.txt',
      '--- a/space.txt',
      '+++ b/space.txt',
      '@@ -1,2 +1,3 @@',
      ' ',
      '- trailing  ',
      '+ trailing   ',
      '+diff --git a/not-a-file b/not-a-file',
      ''
    ].join('\n'));
    expect(file.hunks[0].lines[0].text).toBe('');
    expect(file.hunks[0].lines[2].text).toBe(' trailing   ');
    expect(file.hunks[0].lines[3].text).toBe('diff --git a/not-a-file b/not-a-file');
  });

  it('decodes Git quoted octal UTF-8 and escaped paths', () => {
    const [file] = parseDiff('diff --git "a/caf\\303\\251\\t\\\".txt" "b/caf\\303\\251\\t\\\".txt"\n--- "a/caf\\303\\251\\t\\\".txt"\n+++ "b/caf\\303\\251\\t\\\".txt"\n@@ -1 +1 @@\n-old\n+new\n');
    expect(file.path).toBe('café\t".txt');
  });

  it('represents pure renames and binary files without invented hunks', () => {
    const files = parseDiff(`diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
diff --git a/data.bin b/data.bin
index abcdef..abcdef 100644
Binary files a/data.bin and b/data.bin differ
`);
    expect(files[0]).toMatchObject({ path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed', hunks: [] });
    expect(files[1]).toMatchObject({ path: 'data.bin', binary: true, hunks: [], additions: 0, deletions: 0 });
  });

  it('uses raw metadata as the source of truth for unusual file names', () => {
    const [file] = parseDiff('diff --git a/ambiguous b/path b/ambiguous b/path\nBinary files a/ambiguous b/path and b/ambiguous b/path differ\n', [{ path: 'ambiguous b/path', status: 'added' }], true);
    expect(file).toMatchObject({ path: 'ambiguous b/path', status: 'added', binary: true, untracked: true });
    expect(() => parseDiff('', [{ path: 'missing.txt', status: 'modified' }])).toThrow('incomplete patch');
  });
});
