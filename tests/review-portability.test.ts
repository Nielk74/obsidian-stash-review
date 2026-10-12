import {describe, expect, it} from 'vitest';
import {parsePortableReview, serializePortableReview} from '../src/review-portability';
import {emptyMetadata, type DiffFile} from '../src/types';

function portable() {
  const file: DiffFile = {path: 'src/é [1].ts', status: 'modified', additions: 1, deletions: 1, binary: false, untracked: false,
    oldMode: '100644', newMode: '100644', oldBlob: 'b'.repeat(40), newBlob: 'c'.repeat(40),
    oldContent: 'const old = 1;\n', newContent: 'const next = 2;\n',
    fingerprint: JSON.stringify(['100644','b'.repeat(40),'100644','c'.repeat(40),'src/é [1].ts','src/é [1].ts',false]),
    hunks: [{header: '@@ -1 +1 @@', oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [{type: 'delete', oldLine: 1, text: 'const old = 1;'}, {type: 'add', newLine: 1, text: 'const next = 2;'}]}]};
  return {format: 'stash-review' as const, version: 1 as const, repository: {id: 'repo', name: 'Notes'},
    stash: {hash: 'a'.repeat(40), baseHash: 'd'.repeat(40), message: 'Keep work', branch: 'main', ref: 'stash@{0}', createdAt: '2026-10-12T10:00:00Z'},
    metadata: {...emptyMetadata(), description: '[[Project]]', reviewedFiles: ['src/é [1].ts']},
    layers: {all: {context: 5, files: [file]}, staged: {context: 5, files: []}, unstaged: {context: 5, files: [file]}}};
}

describe('portable review packages', () => {
  it('round trips original code, fingerprints, Unicode paths and notes', () => {
    const source = serializePortableReview(portable());
    const restored = parsePortableReview(source);
    expect(restored.repository).toEqual({id: 'repo', name: 'Notes'});
    expect(restored.layers.all.files[0].path).toBe('src/é [1].ts');
    expect(restored.layers.all.files[0].newContent).toBe('const next = 2;\n');
    expect(restored.metadata.description).toBe('[[Project]]');
    expect(serializePortableReview(restored)).toBe(source);
  });
  it('does not carry local executable or repository paths into an imported package', () => {
    const value = {...portable(), settings: {gitPath: 'dangerous.exe'}, repository: {...portable().repository, path: 'C:/private/repo'}};
    const restored = parsePortableReview(JSON.stringify(value));
    expect(restored.repository).toEqual({id: 'repo', name: 'Notes'});
    expect(restored).not.toHaveProperty('settings');
  });
  it.each(['../escape.ts', '/absolute.ts', 'C:/absolute.ts', 'nul\0name.ts'])('rejects invalid saved paths before import: %s', path => {
    const value = portable();
    value.layers.all.files[0].path = path;
    expect(() => parsePortableReview(JSON.stringify(value))).toThrow(/path/i);
  });
  it('rejects inconsistent line coordinates, source text and fingerprints', () => {
    const coordinates = portable();
    coordinates.layers.all.files[0].hunks[0].lines[1].newLine = 9;
    expect(() => parsePortableReview(JSON.stringify(coordinates))).toThrow(/line|hunk/i);
    const contents = portable();
    contents.layers.all.files[0].newContent = 'Different source\n';
    expect(() => parsePortableReview(JSON.stringify(contents))).toThrow(/source|content|line/i);
    const fingerprint = portable();
    fingerprint.layers.all.files[0].newBlob = 'e'.repeat(40);
    expect(() => parsePortableReview(JSON.stringify(fingerprint))).toThrow(/fingerprint/i);
  });
  it('rejects oversized and malformed packages rather than keeping partial reviews', () => {
    expect(() => parsePortableReview(' '.repeat(32 * 1024 * 1024 + 1))).toThrow(/32|size|large/i);
    expect(() => parsePortableReview('{broken')).toThrow(/JSON|package/i);
    const value = portable();
    (value.layers as Record<string, unknown>).staged = null;
    expect(() => parsePortableReview(JSON.stringify(value))).toThrow(/layer/i);
  });
  it('accepts SHA-256 object identities without confusing them with SHA-1', () => {
    const value = portable();
    value.stash.hash = 'a'.repeat(64); value.stash.baseHash = 'd'.repeat(64);
    const file = value.layers.all.files[0];
    file.oldBlob = 'b'.repeat(64); file.newBlob = 'c'.repeat(64);
    file.fingerprint = JSON.stringify([file.oldMode,file.oldBlob,file.newMode,file.newBlob,file.path,file.path,false]);
    expect(parsePortableReview(JSON.stringify(value)).stash.hash).toHaveLength(64);
  });
});
