import { DEFAULT_SETTINGS, type PluginData, type SavedLayer, type DiffLayer, type DiffFile, type Repository, type ReviewHost, type ReviewTarget, type Stash, type StashMetadata } from '../src/types';
import {loadPluginData, readMetadata, reviewMarkdown, reviewSummary} from '../src/review-store';
import {DataTransactions, ReviewLibrary, type LibraryGit} from '../src/review-library';
import {fileFingerprint, parseSavedLayer} from '../src/review-portability';
import {renderPreviewMarkdown} from '../src/ui/MarkdownText';
import { demoStashes, fixtureDiff, initialMetadata } from './fixtures';

const STORAGE_KEY = 'stash-review-demo-v1';
export const DEMO_REPOSITORY_ID = 'demo-fieldbook';
interface DemoState {
  stashes: Stash[];
  metadata: Record<string, StashMetadata>;
  dirty: boolean;
  omittedUntracked: string[];
  backups: Record<string, Stash>;
  retained?: Record<string, Stash>;
  data?: PluginData;
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
  private state = readState();
  private data = loadPluginData(this.state.data ?? {settings:{...DEFAULT_SETTINGS,repositories:['/Demo vault/fieldbook'],contextLines:3},reviews:{[DEMO_REPOSITORY_ID]:this.state.metadata},repositoryCatalog:{[DEMO_REPOSITORY_ID]:{id:DEMO_REPOSITORY_ID,name:'fieldbook',paths:['/Demo vault/fieldbook']}}});
  get settings() {return this.data.settings;}
  private writes = new DataTransactions(() => this.data,data => {
    const previous=this.data; this.data=data; this.state.data=data; this.state.metadata=data.reviews[DEMO_REPOSITORY_ID] ?? {};
    for (const [id,reviews] of Object.entries(data.reviews)) for (const [hash,metadata] of Object.entries(reviews)) if (JSON.stringify(previous.reviews[id]?.[hash])!==JSON.stringify(metadata)) this.metadataListeners.forEach(listener => listener(id,hash));
  },async data => {
    localStorage.setItem(STORAGE_KEY,JSON.stringify({...this.state,data,metadata:data.reviews[DEMO_REPOSITORY_ID] ?? {}}));
  });
  private git: LibraryGit = {
    resolveRepository: async path => ({...this.repository(),path}),
    listStashes: async () => this.liveStashes(),
    retainStash: async (_repo,stash) => {this.state.retained ??= {}; if (!this.state.retained[stash.hash]) {this.state.retained[stash.hash]=clone(stash); this.persist();}},
    listRetainedStashes: async () => Object.values({...this.state.backups,...this.state.retained}),
    getDiff: (_repo,stash,layer,context) => this.rawDiff(stash,layer,context ?? 5),
    getFileContents: async (_repo,stash,file,layer) => {
      const complete=fixtureDiff(stash.hash,layer,1000,!this.state.omittedUntracked.includes(stash.hash)).find(candidate => candidate.path===file.path);
      return {oldContent:complete?.oldContent ?? '',newContent:complete?.newContent ?? ''};
    }
  };
  private library = new ReviewLibrary({getData:() => this.data,transaction:change => this.writes.transaction(change),storage:{
    async read(id,hash,layer) {const value=localStorage.getItem(`stash-review-snapshot:${id}:${hash}:${layer}`); return value ? parseSavedLayer(JSON.parse(value)) : undefined;},
    async write(id,hash,layer,snapshot:SavedLayer) {localStorage.setItem(`stash-review-snapshot:${id}:${hash}:${layer}`,JSON.stringify(snapshot));}
  },warn:message => this.notify(message)},this.git);
  private scenario = new URLSearchParams(location.search).get('state');
  readonly operations: Array<{ name: string; hash?: string; restoreIndex?: boolean; includeUntracked?: boolean }> = [];

  private repository(): Repository {
    return { id: DEMO_REPOSITORY_ID, path: '/Demo vault/fieldbook', name: 'fieldbook', branch: 'main', dirty: this.state.dirty };
  }
  private persist(): void {this.state.data=this.data; this.state.metadata=this.data.reviews[DEMO_REPOSITORY_ID] ?? {}; localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); }
  private record(operation: DemoHost['operations'][number]): void {
    this.operations.push(operation);
    window.dispatchEvent(new CustomEvent('demo-operation', { detail: operation }));
  }
  async listRepositories(): Promise<Repository[]> {
    if (this.scenario === 'error') throw new Error('Git could not open the demo repository. Check the repository path and Git executable.');
    if (this.scenario === 'no-repository') return [];
    const live=this.repository(), binding=this.data.repositoryCatalog?.[DEMO_REPOSITORY_ID];
    if (binding?.paths[0]) live.path=binding.paths[0];
    return [live,...Object.values(this.data.repositoryCatalog ?? {}).filter(binding => binding.id!==DEMO_REPOSITORY_ID).map(binding => ({id:binding.id,path:`library://${binding.id}`,name:binding.name,branch:'',dirty:false,offline:true}))];
  }
  async addRepository(path: string): Promise<Repository> {
    if (!path.trim()) throw new Error('Enter a repository path.');
    this.scenario = null;
    return this.repository();
  }
  private async liveStashes(): Promise<Stash[]> {
    if (this.scenario === 'empty') return [];
    return clone(this.state.stashes).map((stash, index) => ({ ...stash, ref: `stash@{${index}}` }));
  }
  async listStashes(repository?: Repository): Promise<Stash[]> {return this.library.listActiveStashes(repository ?? this.repository());}
  private async rawDiff(stash: Stash, layer: DiffLayer, context: number): Promise<DiffFile[]> {
    if (this.scenario === 'diff-error') throw new Error('The saved Git object is unavailable. Refresh the stash list.');
    const files=fixtureDiff(stash.hash, layer, context, !this.state.omittedUntracked.includes(stash.hash));
    const blob=async (source:string) => {const bytes=new TextEncoder().encode(source), header=new TextEncoder().encode(`blob ${bytes.length}\0`), value=new Uint8Array(header.length+bytes.length); value.set(header); value.set(bytes,header.length); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',value)),b => b.toString(16).padStart(2,'0')).join('');};
    return Promise.all(files.map(async file => {file.oldMode=file.status==='added' ? '000000' : '100644'; file.newMode=file.status==='deleted' ? '000000' : '100644'; file.oldBlob=file.status==='added' ? '0'.repeat(40) : await blob(file.oldContent ?? ''); file.newBlob=file.status==='deleted' ? '0'.repeat(40) : await blob(file.newContent ?? ''); file.fingerprint=fileFingerprint(file); return file;}));
  }
  getDiff(repository:Repository,stash:Stash,layer:DiffLayer,context:number) {return this.library.getDiff(repository,stash,layer,context);}
  getFileContents(repository:Repository,stash:Stash,file:DiffFile,layer:DiffLayer) {return this.library.getFileContents(repository,stash,file,layer);}
  getMetadata(repositoryId: string, hash: string): StashMetadata {return readMetadata(this.data,repositoryId,hash);}
  getReviewSummary(id:string,hash:string) {return reviewSummary(this.data,id,hash);}
  listArchivedReviews(repository:Repository) {return this.library.listArchivedReviews(repository);}
  archiveReview(repository:Repository,stash:Stash,archived:boolean) {return this.library.archiveReview(repository,stash,archived);}
  continueReview(repository:Repository,stash:Stash,hash:string) {return this.library.continueReview(repository,stash,hash);}
  relocateRepository(id:string,path:string) {return this.library.relocateRepository(id,path);}
  exportReviewData(repository:Repository,stash:Stash) {return this.library.exportReviewData(repository,stash);}
  importReviewData(source:string,id?:string) {return this.library.importReviewData(source,id);}
  invalidateReads() {this.library.clear();}
  renderMarkdown=renderPreviewMarkdown;
  updateMetadata(repositoryId: string, hash: string, change: (previous: StashMetadata) => StashMetadata): {metadata: StashMetadata; saved: Promise<void>} {
    const metadata = change(this.getMetadata(repositoryId, hash));
    return {metadata, saved: this.saveMetadata(repositoryId, hash, metadata)};
  }
  async saveMetadata(repositoryId: string, hash: string, metadata: StashMetadata): Promise<void> {
    const saved=this.writes.saveMetadata(repositoryId,hash,metadata);
    for (const listener of this.metadataListeners) listener(repositoryId, hash);
    await saved;
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
    if (_repository.offline) throw new Error('Connect the repository first.');
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
    if (_repository.offline) throw new Error('Connect the repository first.');
    if (this.state.dirty) throw new Error('The working tree has local changes. Stash or commit them before applying another stash.');
    if (!this.state.stashes.some(candidate => candidate.hash === stash.hash)) throw new Error('This stash is no longer in the list. Refresh before applying.');
    this.state.dirty = true;
    this.persist();
    this.record({ name: 'apply', hash: stash.hash, restoreIndex });
  }
  async dropStash(_repository: Repository, stash: Stash): Promise<void> {
    if (_repository.offline) throw new Error('Connect the repository first.');
    const found = this.state.stashes.find(candidate => candidate.hash === stash.hash);
    if (!found) throw new Error('This stash is no longer in the list. Refresh before removing.');
    this.state.backups[stash.hash] = clone(found);
    this.state.stashes = this.state.stashes.filter(candidate => candidate.hash !== stash.hash);
    this.persist();
    this.record({ name: 'drop', hash: stash.hash });
  }
  async restoreDroppedStash(_repository: Repository, stash: Stash): Promise<void> {
    if (_repository.offline) throw new Error('Connect the repository first.');
    const found = this.state.backups[stash.hash] ?? this.state.retained?.[stash.hash];
    if (!found) throw new Error('No demo backup was found for this stash.');
    if (!this.state.stashes.some(candidate => candidate.hash === stash.hash)) this.state.stashes.unshift(found);
    this.persist();
    this.record({ name: 'restore', hash: stash.hash });
  }
  async exportReview(repository: Repository, stash: Stash, metadata: StashMetadata): Promise<string> {
    metadata=await this.library.withExcerpts(repository,stash,metadata);
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
