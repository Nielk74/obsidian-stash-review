import { DEFAULT_SETTINGS, emptyMetadata, type DiffLayer, type DiffFile, type Repository, type ReviewHost, type ReviewTarget, type Stash, type StashMetadata } from '../src/types';
import {reviewMarkdown} from '../src/review-store';
import { demoStashes, fixtureDiff, initialMetadata } from './fixtures';

const STORAGE_KEY = 'stash-review-demo-v1';
export const DEMO_REPOSITORY_ID = 'demo-fieldbook';
interface DemoState {
  stashes: Stash[];
  metadata: Record<string, StashMetadata>;
  dirty: boolean;
  omittedUntracked: string[];
  backups: Record<string, Stash>;
}

function readState(): DemoState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const state = JSON.parse(stored) as DemoState;
      return { ...state, backups: state.backups ?? {} };
    }
  } catch { /* A blocked browser store should not prevent the preview. */ }
  return {
    stashes: structuredClone(demoStashes), metadata: structuredClone(initialMetadata),
    dirty: true, omittedUntracked: [], backups: {}
  };
}

function clone<T>(value: T): T { return structuredClone(value); }

export class DemoHost implements ReviewHost {
  readonly vaultName = 'Demo vault';
  private metadataListeners = new Set<(repositoryId: string, hash: string) => void>();
  readonly settings = { ...DEFAULT_SETTINGS, repositories: ['/Demo vault/fieldbook'], contextLines: 3 };
  private state = readState();
  private scenario = new URLSearchParams(location.search).get('state');
  readonly operations: Array<{ name: string; hash?: string; restoreIndex?: boolean; includeUntracked?: boolean }> = [];

  private repository(): Repository {
    return { id: DEMO_REPOSITORY_ID, path: '/Demo vault/fieldbook', name: 'fieldbook', branch: 'main', dirty: this.state.dirty };
  }
  private persist(): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); }
  private record(operation: DemoHost['operations'][number]): void {
    this.operations.push(operation);
    window.dispatchEvent(new CustomEvent('demo-operation', { detail: operation }));
  }
  async listRepositories(): Promise<Repository[]> {
    if (this.scenario === 'error') throw new Error('Git could not open the demo repository. Check the repository path and Git executable.');
    if (this.scenario === 'no-repository') return [];
    return [this.repository()];
  }
  async addRepository(path: string): Promise<Repository> {
    if (!path.trim()) throw new Error('Enter a repository path.');
    this.scenario = null;
    return this.repository();
  }
  async listStashes(): Promise<Stash[]> {
    if (this.scenario === 'empty') return [];
    return clone(this.state.stashes).map((stash, index) => ({ ...stash, ref: `stash@{${index}}` }));
  }
  async getDiff(_repository: Repository, stash: Stash, layer: DiffLayer, context: number): Promise<DiffFile[]> {
    if (this.scenario === 'diff-error') throw new Error('The saved Git object is unavailable. Refresh the stash list.');
    return fixtureDiff(stash.hash, layer, context, !this.state.omittedUntracked.includes(stash.hash));
  }
  async getFileContents(_repository: Repository, stash: Stash, file: DiffFile, layer: DiffLayer): Promise<{ oldContent: string; newContent: string }> {
    const complete = fixtureDiff(stash.hash, layer, 1000, !this.state.omittedUntracked.includes(stash.hash)).find(candidate => candidate.path === file.path);
    return { oldContent: complete?.oldContent ?? '', newContent: complete?.newContent ?? '' };
  }
  getMetadata(_repositoryId: string, hash: string): StashMetadata {
    return clone(this.state.metadata[hash] ?? emptyMetadata());
  }
  updateMetadata(repositoryId: string, hash: string, change: (previous: StashMetadata) => StashMetadata): {metadata: StashMetadata; saved: Promise<void>} {
    const metadata = change(this.getMetadata(repositoryId, hash));
    return {metadata, saved: this.saveMetadata(repositoryId, hash, metadata)};
  }
  async saveMetadata(_repositoryId: string, hash: string, metadata: StashMetadata): Promise<void> {
    this.state.metadata[hash] = clone(metadata);
    this.persist();
    for (const listener of this.metadataListeners) listener(DEMO_REPOSITORY_ID, hash);
  }
  subscribeMetadata(listener: (repositoryId: string, hash: string) => void): () => void {
    this.metadataListeners.add(listener);
    return () => {this.metadataListeners.delete(listener);};
  }
  async openReview(target: ReviewTarget): Promise<void> {
    const query = new URLSearchParams({repo: target.repositoryId, stash: target.stashHash, layer: target.layer ?? 'all'});
    if (target.file) query.set('file', target.file);
    history.replaceState(null, '', '?' + query);
    window.dispatchEvent(new CustomEvent('demo-open-review', {detail: target}));
  }
  async createStash(_repository: Repository, message: string, includeUntracked: boolean): Promise<void> {
    if (!this.state.dirty) throw new Error('No local changes to stash.');
    const hash = crypto.randomUUID().replaceAll('-', '') + 'a1b2c3d4';
    this.state.stashes.unshift({
      hash, ref: 'stash@{0}', message: `On main: ${message || 'work in progress'}`, branch: 'main',
      createdAt: new Date().toISOString(), baseHash: demoStashes[0].baseHash
    });
    if (!includeUntracked) this.state.omittedUntracked.push(hash);
    this.state.dirty = false;
    this.persist();
    this.record({ name: 'create', hash, includeUntracked });
  }
  async applyStash(_repository: Repository, stash: Stash, restoreIndex: boolean): Promise<void> {
    if (this.state.dirty) throw new Error('The working tree has local changes. Stash or commit them before applying another stash.');
    if (!this.state.stashes.some(candidate => candidate.hash === stash.hash)) throw new Error('This stash is no longer in the list. Refresh before applying.');
    this.state.dirty = true;
    this.persist();
    this.record({ name: 'apply', hash: stash.hash, restoreIndex });
  }
  async dropStash(_repository: Repository, stash: Stash): Promise<void> {
    const found = this.state.stashes.find(candidate => candidate.hash === stash.hash);
    if (!found) throw new Error('This stash is no longer in the list. Refresh before removing.');
    this.state.backups[stash.hash] = clone(found);
    this.state.stashes = this.state.stashes.filter(candidate => candidate.hash !== stash.hash);
    this.persist();
    this.record({ name: 'drop', hash: stash.hash });
  }
  async restoreDroppedStash(_repository: Repository, stash: Stash): Promise<void> {
    const found = this.state.backups[stash.hash];
    if (!found) throw new Error('No demo backup was found for this stash.');
    if (!this.state.stashes.some(candidate => candidate.hash === stash.hash)) this.state.stashes.unshift(found);
    this.persist();
    this.record({ name: 'restore', hash: stash.hash });
  }
  async exportReview(repository: Repository, stash: Stash, metadata: StashMetadata): Promise<string> {
    const markdown = reviewMarkdown(repository, stash, metadata, this.vaultName);
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'stash-review.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'stash-review.md';
  }
  notify(message: string): void { window.dispatchEvent(new CustomEvent('demo-notice', { detail: message })); }
  openSettings(): void { this.notify('Demo settings: the real plugin supports your vault repository and additional local repositories.'); }
}

declare global {
  interface Window {
    __demoHost: DemoHost;
  }
}
