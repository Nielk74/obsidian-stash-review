import { describe, expect, it } from 'vitest';
import { loadPluginData, readMetadata, reviewMarkdown } from '../src/review-store';
import { emptyMetadata, type Repository, type Stash } from '../src/types';
import * as store from '../src/review-store';

describe('durable review data', () => {
  it('migrates legacy progress only to All without losing notes', () => {
    const data = loadPluginData({version: 1, reviews: {repo: {hash: {...emptyMetadata(), title: 'Keep me', reviewedFiles: ['app.ts']}}}});
    const metadata = readMetadata(data, 'repo', 'hash');
    expect(data.version).toBe(2);
    expect(store.reviewedPaths(metadata, 'all')).toEqual(['app.ts']);
    expect(store.reviewedPaths(metadata, 'staged')).toEqual([]);
    expect(store.reviewedPaths(metadata, 'unstaged')).toEqual([]);
    expect(metadata.title).toBe('Keep me');
  });
  it('persists independent layer progress and keeps the legacy All representation synchronized', () => {
    const original = {...emptyMetadata(), reviewedFiles: ['all.ts']};
    const staged = store.withReviewedPath(original, 'staged', 'app.ts', true);
    const unstaged = store.withReviewedPath(staged, 'unstaged', 'other.ts', true);
    const all = store.withReviewedPath(unstaged, 'all', 'added.ts', true);
    const data = loadPluginData(JSON.parse(JSON.stringify({reviews: {repo: {hash: all}}})));
    const restored = readMetadata(data, 'repo', 'hash');
    expect(store.reviewedPaths(restored, 'staged')).toEqual(['app.ts']);
    expect(store.reviewedPaths(restored, 'unstaged')).toEqual(['other.ts']);
    expect(restored.reviewedFiles).toEqual(['all.ts', 'added.ts']);
    expect(store.reviewedPaths(store.withReviewedPath(restored, 'staged', 'app.ts', false), 'all')).toEqual(['all.ts', 'added.ts']);
    expect(original).toEqual({...emptyMetadata(), reviewedFiles: ['all.ts']});
  });
  it('continues only exact matching layer files and keeps both original and current discussions', () => {
    const annotation = {id: 'same', path: 'same.ts', side: 'new' as const, layer: 'staged' as const, startLine: 2, endLine: 2, body: 'Original', createdAt: '', updatedAt: '', resolved: false, replies: [{id: 'reply', body: 'Keep reply', createdAt: ''}]};
    const previous = {...emptyMetadata(), title: 'Previous', description: '[[Context]]', tags: ['prior'], pinned: true,
      reviewedByLayer: {all: ['same.ts'], staged: ['same.ts'], unstaged: ['same.ts']},
      annotations: [annotation, {...annotation, id: 'changed', layer: 'unstaged' as const, body: 'Changed content'}]};
    const current = {...emptyMetadata(), title: 'Current', tags: ['next'], annotations: [{...annotation, id: 'current', body: 'New discussion'}]};
    const before = structuredClone(previous);
    const next = store.continueMetadata(previous, current, {staged: new Set(['same.ts'])}, 'a'.repeat(40));
    expect(next.title).toBe('Current');
    expect(next.description).toBe('[[Context]]');
    expect(next.tags).toEqual(['next', 'prior']);
    expect(next.pinned).toBe(true);
    expect(next.continuedFrom).toBe('a'.repeat(40));
    expect(store.reviewedPaths(next, 'staged')).toEqual(['same.ts']);
    expect(store.reviewedPaths(next, 'all')).toEqual([]);
    expect(store.reviewedPaths(next, 'unstaged')).toEqual([]);
    expect(next.annotations.map(item => item.id)).toEqual(['current', 'same']);
    expect(next.annotations[1].replies[0].body).toBe('Keep reply');
    next.annotations[1].replies[0].body = 'Edited copy';
    expect(previous).toEqual(before);
    expect(current.annotations).toHaveLength(1);
  });
  it('keeps changed-file and unverifiable legacy notes on their original revision', () => {
    const previous = {...emptyMetadata(), reviewedFiles: ['changed.ts'], annotations: [{id: 'old', path: 'changed.ts', side: 'old' as const, layer: 'all' as const, startLine: 3, endLine: 4, body: 'Do not move my anchor', createdAt: '', updatedAt: '', resolved: false, replies: []}]};
    const next = store.continueMetadata(previous, emptyMetadata(), {}, 'b'.repeat(40));
    expect(next.annotations).toEqual([]);
    expect(next.reviewedFiles).toEqual([]);
    expect(previous.annotations[0].body).toBe('Do not move my anchor');
    expect(previous.reviewedFiles).toEqual(['changed.ts']);
  });
  it('validates layer fields and preserves excerpts through a restart', () => {
    const excerpt = {text: 'const original = "<safe>";', startLine: 2};
    const annotation = {id: 'excerpt', path: 'app.ts', side: 'new', layer: 'all', startLine: 2, endLine: 2, body: 'Keep source', createdAt: '', updatedAt: '', resolved: false, replies: [], excerpt};
    const data = loadPluginData({reviews: {repo: {hash: {...emptyMetadata(), reviewedByLayer: {all: ['app.ts', null, 42, 'app.ts'], staged: 'broken', unstaged: ['u.ts']}, annotations: [annotation]}}}});
    const metadata = readMetadata(data, 'repo', 'hash');
    expect(store.reviewedPaths(metadata, 'all')).toEqual(['app.ts']);
    expect(store.reviewedPaths(metadata, 'staged')).toEqual([]);
    expect(store.reviewedPaths(metadata, 'unstaged')).toEqual(['u.ts']);
    expect(metadata.reviewedFiles).toEqual(['app.ts']);
    expect(metadata.annotations[0].excerpt).toEqual(excerpt);
    metadata.annotations[0].excerpt!.text = 'Changed copy';
    expect(readMetadata(data, 'repo', 'hash').annotations[0].excerpt!.text).toBe('const original = "<safe>";');
  });
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
  it('exports per-layer progress and original annotated code without losing missing-source notes', () => {
    const repository: Repository = {id:'repo',name:'Notes',path:'C:/notes',branch:'main',dirty:false};
    const stash: Stash = {hash:'a'.repeat(40),baseHash:'b'.repeat(40),ref:'stash@{0}',message:'Review',branch:'main',createdAt:''};
    const annotation = {id:'source',path:'app.ts',side:'new' as const,layer:'staged' as const,startLine:2,endLine:2,body:'Keep original',createdAt:'',updatedAt:'',resolved:false,replies:[],excerpt:{text:'const original = "<safe>";',startLine:2}};
    const metadata = {...emptyMetadata(),reviewedByLayer:{staged:['app.ts']},annotations:[annotation,{...annotation,id:'missing',path:'lost.ts',excerpt:undefined}]};
    const markdown = reviewMarkdown(repository,stash,metadata);
    expect(markdown).toContain('Staged'); expect(markdown).toContain('- [x] app.ts');
    expect(markdown).toContain('const original = "<safe>";');
    expect(markdown).toContain('Original new lines 2');
    expect(markdown).toContain('Original code excerpt unavailable');
    expect(markdown).toContain('lost.ts');
  });
});
