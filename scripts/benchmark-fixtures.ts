import {DEFAULT_SETTINGS, emptyMetadata, type Annotation, type DiffFile, type DiffLine, type Repository, type ReviewHost, type Stash, type StashMetadata} from '../src/types';
import {reviewMarkdown} from '../src/review-store';

export function fixtureFile(index: number, lineCount = 80, changedCount = 3): DiffFile {
  const before = Array.from({length: lineCount}, (_, line) => 'export const value_' + index + '_' + line + ' = "before";');
  const after = before.map((text, line) => line < changedCount ? text.replace('before', 'after') : text);
  const lines: DiffLine[] = [];
  const visibleCount = Math.min(lineCount, changedCount + 3);
  for (let line = 0; line < visibleCount; line++) {
    if (line < changedCount) {
      lines.push({type: 'delete', oldLine: line + 1, text: before[line]});
      lines.push({type: 'add', newLine: line + 1, text: after[line]});
    } else lines.push({type: 'context', oldLine: line + 1, newLine: line + 1, text: after[line]});
  }
  return {
    path: 'src/area-' + Math.floor(index / 25) + '/module-' + String(index).padStart(4, '0') + '.ts',
    status: 'modified', binary: false, untracked: false, additions: changedCount, deletions: changedCount,
    oldContent: before.join('\n') + '\n', newContent: after.join('\n') + '\n',
    hunks: [{header: '@@ -1,' + visibleCount + ' +1,' + visibleCount + ' @@', oldStart: 1, newStart: 1, oldCount: visibleCount, newCount: visibleCount, lines}]
  };
}

export function fixtureMetadata(files: DiffFile[], noteCount = 10): StashMetadata {
  const annotations: Annotation[] = Array.from({length: noteCount}, (_, index) => ({
    id: 'note-' + index, path: files[index % files.length].path, side: 'new', startLine: 2, endLine: 2,
    layer: 'all', body: 'Review the saved behavior and preserve this note. '.repeat(3),
    createdAt: '2026-10-12T08:00:00.000Z', updatedAt: '2026-10-12T08:00:00.000Z',
    resolved: index % 4 === 0, replies: [{id: 'reply-' + index, body: 'Keep the original snapshot intact.', createdAt: '2026-10-12T08:01:00.000Z'}]
  }));
  return {...emptyMetadata(), title: 'Benchmark saved work', description: 'Deterministic synthetic repository for performance measurements.', tags: ['benchmark'], annotations};
}

export const workloads = {
  typical: {files: 12, lines: 80, changed: 3, stashes: 20, notes: 10},
  'many-files': {files: 1000, lines: 20, changed: 3, stashes: 20, notes: 10},
  'many-stashes': {files: 12, lines: 80, changed: 3, stashes: 1000, notes: 10},
  'many-notes': {files: 12, lines: 80, changed: 3, stashes: 20, notes: 1000},
  'sparse-large-file': {files: 1, lines: 20_000, changed: 3, stashes: 20, notes: 0},
  'dense-large-file': {files: 1, lines: 5000, changed: 5000, stashes: 20, notes: 0},
  'multi-embed': {files: 12, lines: 80, changed: 3, stashes: 20, notes: 10}
} as const;

export class BenchmarkHost implements ReviewHost {
  readonly settings = {...DEFAULT_SETTINGS, contextLines: 3, refreshInterval: 0};
  readonly vaultName = 'Benchmark vault';
  readonly repository: Repository = {id: 'benchmark-repo', path: '/Benchmark/repository', name: 'benchmark-repository', branch: 'main', dirty: false};
  readonly counts = {repositories: 0, stashes: 0, diff: 0, source: 0, saves: 0, exports: 0, mutations: 0};
  readonly listeners = new Set<(repositoryId: string, hash: string) => void>();
  readonly files: DiffFile[];
  stashes: Stash[];
  private metadata = new Map<string, StashMetadata>();
  private nextHash = 100_001;
  constructor(readonly scenario: keyof typeof workloads = 'typical') {
    const workload = workloads[scenario];
    this.files = Array.from({length: workload.files}, (_, index) => fixtureFile(index, workload.lines, workload.changed));
    this.stashes = Array.from({length: workload.stashes}, (_, index) => ({
      hash: (index + 1).toString(16).padStart(40, '0'), ref: 'stash@{' + index + '}',
      message: 'Saved work ' + index, branch: 'main', createdAt: '2026-10-12T08:00:00.000Z', baseHash: 'b'.repeat(40)
    }));
    this.metadata.set(this.stashes[0].hash, fixtureMetadata(this.files, workload.notes));
  }
  async listRepositories() {this.counts.repositories++; return [this.repository];}
  async addRepository() {return this.repository;}
  async listStashes() {this.counts.stashes++; return [...this.stashes];}
  async getDiff() {
    this.counts.diff++;
    return this.files.map(({oldContent: _old, newContent: _next, ...file}) => file);
  }
  async getFileContents(_repository: Repository, _stash: Stash, file: DiffFile) {
    this.counts.source++;
    const source = this.files.find(candidate => candidate.path === file.path)!;
    return {oldContent: source.oldContent!, newContent: source.newContent!};
  }
  getMetadata(_repository: string, hash: string) {return structuredClone(this.metadata.get(hash) ?? emptyMetadata());}
  updateMetadata(repositoryId: string, hash: string, change: (previous: StashMetadata) => StashMetadata) {
    const metadata = change(this.getMetadata(repositoryId, hash));
    return {metadata, saved: this.saveMetadata(repositoryId, hash, metadata)};
  }
  async saveMetadata(repositoryId: string, hash: string, metadata: StashMetadata) {
    this.counts.saves++; this.metadata.set(hash, structuredClone(metadata));
    for (const listener of this.listeners) listener(repositoryId, hash);
  }
  subscribeMetadata(listener: (repositoryId: string, hash: string) => void) {
    this.listeners.add(listener); return () => {this.listeners.delete(listener);};
  }
  async createStash(_repository: Repository, message: string) {
    this.counts.mutations++;
    this.stashes = [{...this.stashes[0], hash: (this.nextHash++).toString(16).padStart(40, '0'), message}, ...this.stashes]
      .map((stash, index) => ({...stash, ref: 'stash@{' + index + '}'}));
  }
  async applyStash() {this.counts.mutations++;}
  async dropStash(_repository: Repository, stash: Stash) {
    this.counts.mutations++; this.stashes = this.stashes.filter(item => item.hash !== stash.hash);
  }
  async restoreDroppedStash(_repository: Repository, stash: Stash) {this.counts.mutations++; this.stashes.unshift(stash);}
  async exportReview(repository: Repository, stash: Stash, metadata: StashMetadata) {
    this.counts.exports++; reviewMarkdown(repository, stash, metadata, this.vaultName); return 'Benchmark review.md';
  }
  async openReview() {}
  notify() {}
  openSettings() {}
}
