import {describe, expect, it} from 'vitest';
import type {DiffFile} from '../src/types';
import {ancestorFolderPaths, buildFileTree, filterFileTree, flattenFileTree, folderPaths} from '../src/ui/file-tree';

const file = (path: string, overrides: Partial<DiffFile> = {}): DiffFile => ({path, status: 'modified', additions: 3, deletions: 1, binary: false, untracked: false, hunks: [], ...overrides});

describe('changed-file tree', () => {
  it('groups only changed files into sorted folders before files at every level', () => {
    const tree = buildFileTree([file('README.md'), file('src/z.ts'), file('src/utils/math.ts'), file('.github/workflows/check.yml'), file('src/a.ts'), file('package.json')]);
    expect(tree.map(node => node.path)).toEqual(['.github', 'src', 'package.json', 'README.md']);
    expect(flattenFileTree(tree).map(row => [row.node.path, row.depth])).toEqual([
      ['.github', 0], ['.github/workflows', 1], ['.github/workflows/check.yml', 2],
      ['src', 0], ['src/utils', 1], ['src/utils/math.ts', 2], ['src/a.ts', 1], ['src/z.ts', 1],
      ['package.json', 0], ['README.md', 0]
    ]);
    expect(folderPaths(tree)).toEqual(['.github', '.github/workflows', 'src', 'src/utils']);
    expect(buildFileTree([file('src/a.ts'), file('src/z.ts')])).toEqual(buildFileTree([file('src/z.ts'), file('src/a.ts')]));
  });

  it('preserves case-sensitive Git paths, Unicode, spaces, dotted folders and duplicate filenames', () => {
    const files = [file('研究/part one/format.ts'), file('src/.cache/format.ts'), file('src/A.ts'), file('src/a.ts'), file('src/line\nbreak.ts')];
    const leaves = flattenFileTree(buildFileTree(files)).filter(row => row.node.kind === 'file');
    expect(new Set(leaves.map(row => row.node.path))).toEqual(new Set(files.map(item => item.path)));
    expect(ancestorFolderPaths('研究/part one/format.ts')).toEqual(['研究', '研究/part one']);
    expect(leaves.filter(row => row.node.path.startsWith('src/')).map(row => row.node.path)).toEqual(['src/.cache/format.ts', 'src/A.ts', 'src/a.ts', 'src/line\nbreak.ts']);
  });

  it('keeps the ancestor chain of search matches including a renamed source path', () => {
    const tree = buildFileTree([file('src/capture/ui/modal.ts'), file('src/utils/format.ts'), file('lib/new.ts', {status: 'renamed', oldPath: 'legacy/old.ts'}), file('README.md')]);
    expect(flattenFileTree(filterFileTree(tree, '  MODAL  '), new Set(['src', 'src/capture']), true).map(row => row.node.path)).toEqual(['src', 'src/capture', 'src/capture/ui', 'src/capture/ui/modal.ts']);
    expect(flattenFileTree(filterFileTree(tree, 'legacy/old')).map(row => row.node.path)).toEqual(['lib', 'lib/new.ts']);
    expect(filterFileTree(tree, 'nothing')).toEqual([]);
    expect(flattenFileTree(tree, new Set(['src'])).map(row => row.node.path)).toEqual(['lib', 'lib/new.ts', 'src', 'README.md']);
  });

  it('aggregates changed-file counts and viewed progress and recalculates visible search totals', () => {
    const tree = buildFileTree([file('src/capture/a.ts', {additions: 7, deletions: 2}), file('src/capture/b.ts'), file('src/utils/a.ts'), file('README.md')], ['src/capture/a.ts', 'src/utils/a.ts', 'missing.ts']);
    const src = tree.find(node => node.path === 'src');
    expect(src).toMatchObject({fileCount: 3, reviewedCount: 2, additions: 13, deletions: 4});
    const searched = filterFileTree(tree, 'capture/a');
    expect(searched[0]).toMatchObject({fileCount: 1, reviewedCount: 1, additions: 7, deletions: 2});
    expect(src).toMatchObject({fileCount: 3, reviewedCount: 2});
  });

  it('uses destination folders for renames and retains binary and untracked metadata', () => {
    const files = [file('assets/final.png', {oldPath: 'old image.png', status: 'renamed', binary: true, additions: 0, deletions: 0}), file('scratch/new file.ts', {status: 'added', untracked: true})];
    const leaves = flattenFileTree(buildFileTree(files)).filter(row => row.node.kind === 'file').map(row => row.node);
    expect(leaves).toHaveLength(2);
    expect(leaves[0]).toMatchObject({path: 'assets/final.png', parentPath: 'assets', file: {binary: true, oldPath: 'old image.png'}});
    expect(leaves[1]).toMatchObject({path: 'scratch/new file.ts', file: {untracked: true}});
  });
});
