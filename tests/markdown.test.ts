import {describe, expect, it} from 'vitest';
import {createReviewLink, markdownEmbed, markdownLink, parseReviewBlock, parseReviewParameters} from '../src/markdown';

const stashHash = '0123456789abcdef0123456789abcdef01234567';
const target = {repositoryId: 'repo-1', stashHash, layer: 'all' as const};

describe('Markdown stash integration', () => {
  it('encodes vault and file names and preserves the full immutable hash', () => {
    const link = createReviewLink('My vault & notes', {...target, file: 'src/café [idea].ts', layer: 'staged'});
    expect(link).toBe('obsidian://stash-review?vault=My+vault+%26+notes&repo=repo-1&stash=0123456789abcdef0123456789abcdef01234567&layer=staged&file=src%2Fcaf%C3%A9+%5Bidea%5D.ts');
    expect(parseReviewBlock(link)).toEqual({...target, file: 'src/café [idea].ts', layer: 'staged'});
  });
  it('escapes a Markdown label without changing the URL', () => {
    expect(markdownLink('Idea [one]\nnext', 'obsidian://stash-review?repo=r')).toBe('[Idea \\[one\\] next](obsidian://stash-review?repo=r)');
  });
  it('accepts a copied link or explicit fields as an embed definition', () => {
    const link = createReviewLink('Notes', target);
    expect(markdownEmbed(link)).toBe('```stash-review\n' + link + '\n```');
    expect(parseReviewBlock(`repo: repo-1\nstash: ${stashHash}\nlayer: unstaged\nfile: src/my file.ts`)).toEqual({...target, layer: 'unstaged', file: 'src/my file.ts'});
    expect(parseReviewParameters({repo: 'repo-1', stash: stashHash})).toEqual(target);
  });
  it('supports full SHA-256 stash hashes', () => {
    expect(parseReviewParameters({repo: 'repo-1', stash: 'a'.repeat(64)}).stashHash).toBe('a'.repeat(64));
  });
  it.each([
    [{repo: 'repo-1', stash: 'stash@{0}'}, 'full stash commit hash'],
    [{repo: 'repo-1', stash: 'abc1234'}, 'full stash commit hash'],
    [{repo: '', stash: stashHash}, 'repository'],
    [{repo: 'repo-1', stash: stashHash, layer: 'working'}, 'layer'],
    [{repo: 'repo-1', stash: stashHash, file: 'src\0bad.ts'}, 'file']
  ])('rejects invalid target parameters without choosing another stash', (parameters, message) => {
    expect(() => parseReviewParameters(parameters)).toThrow(message);
  });
  it.each([
    'https://example.com/stash',
    'obsidian://open?vault=Notes',
    `repo: repo-1\nstash: ${stashHash}\ncommand: apply`,
    `repo: repo-1\nrepo: repo-2\nstash: ${stashHash}`,
    'not an embed definition'
  ])('rejects unrelated URLs, unsupported fields, and duplicate keys', source => {
    expect(() => parseReviewBlock(source)).toThrow();
  });
});
