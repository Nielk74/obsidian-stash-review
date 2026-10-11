import { describe, expect, it } from 'vitest';
import { loadPluginData, readMetadata, reviewMarkdown } from '../src/review-store';
import { emptyMetadata, type Repository, type Stash } from '../src/types';

describe('durable review data', () => {
  it('loads defaults and validates settings from malformed saved data', () => {
    expect(loadPluginData(null).settings.gitPath).toBe('git');
    const loaded = loadPluginData({ settings: { repositories: [' /work/repo ', 12, ''], contextLines: -1, refreshInterval: 'bad', defaultView: 'bogus' }, reviews: [] });
    expect(loaded.settings.repositories).toEqual(['/work/repo']);
    expect(loaded.settings.contextLines).toBe(5);
    expect(loaded.settings.refreshInterval).toBe(30);
    expect(loaded.reviews).toEqual({});
  });
  it('keeps annotations with the stash hash when refs shift and isolates repositories', () => {
    const data = loadPluginData(null);
    const metadata = { ...emptyMetadata(), title: 'Keep this idea', reviewedFiles: ['app.ts'] };
    data.reviews.repoA = { hash1: metadata };
    const saved = loadPluginData(JSON.parse(JSON.stringify(data)));
    expect(readMetadata(saved, 'repoA', 'hash1').title).toBe('Keep this idea');
    expect(readMetadata(saved, 'repoB', 'hash1').title).toBe('');
    expect(readMetadata(saved, 'repoA', 'hash2').title).toBe('');
    const read = readMetadata(saved, 'repoA', 'hash1');
    read.reviewedFiles.push('other.ts');
    expect(readMetadata(saved, 'repoA', 'hash1').reviewedFiles).toEqual(['app.ts']);
  });
  it('recovers valid review data without crashing on malformed saved replies or anchors', () => {
    const valid = { id: 'note', path: 'app.ts', side: 'new', startLine: 2, endLine: 4, layer: 'all', body: 'Keep this note', replies: [null, 42, { id: 'reply', body: 'Keep this reply' }], resolved: false };
    const data = loadPluginData({ reviews: { broken: 'invalid', repo: { hash: { title: 'Preserve title', annotations: [null, valid, { ...valid, id: 'bad-anchor', startLine: -1 }] } } } });
    const recovered = readMetadata(data, 'repo', 'hash');
    expect(data.reviews).not.toHaveProperty('broken');
    expect(recovered.title).toBe('Preserve title');
    expect(recovered.annotations).toHaveLength(1);
    expect(recovered.annotations[0].replies).toEqual([{ id: 'reply', body: 'Keep this reply', createdAt: '' }]);
    expect(() => reviewMarkdown({ id: 'repo', name: 'Fixture', path: '/fixture', branch: 'main', dirty: false }, { hash: 'a'.repeat(40), baseHash: 'b'.repeat(40), branch: 'main', message: 'Idea', ref: 'stash@{0}', createdAt: '' }, recovered)).not.toThrow();
  });
  it('exports review context, selected ranges, resolutions and replies as a vault note', () => {
    const repository: Repository = { id: 'repo', name: 'notes', path: '/notes', branch: 'main', dirty: false };
    const stash: Stash = { hash: 'a'.repeat(40), ref: 'stash@{3}', message: 'Experiment', branch: 'main', createdAt: '2026-10-12T09:00:00Z', baseHash: 'b'.repeat(40) };
    const metadata = emptyMetadata();
    metadata.title = '<idea> [prototype]';
    metadata.description = 'Save this thought.';
    metadata.annotations.push({ id: '1', path: 'src/app.ts', side: 'new', startLine: 4, endLine: 9, layer: 'all', body: 'Maybe debounce this?', resolved: true, createdAt: stash.createdAt, updatedAt: stash.createdAt, replies: [{id: '2', body: 'Try 100ms.', createdAt: stash.createdAt}] });
    const output = reviewMarkdown(repository, stash, metadata);
    expect(output).toContain('\\<idea\\> \\[prototype\\]');
    expect(output).toContain('new lines 4-9');
    expect(output).toContain('Status: Resolved');
    expect(output).toContain('Try 100ms.');
    expect(output).toContain(stash.hash);
  });
});
