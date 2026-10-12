import {ReadCache} from './read-cache';
import {continueMetadata, DIFF_LAYERS, readMetadata, reviewedPaths} from './review-store';
import {parsePortableReview, serializePortableReview, validRepositoryId} from './review-portability';
import {type DiffFile, type DiffLayer, type PluginData, type Repository, type ReviewEntry, type ReviewTarget, type SavedLayer, type Stash, type StashMetadata} from './types';
import type {GitService} from './git';

export type LibraryGit = Pick<GitService, 'resolveRepository' | 'listStashes' | 'retainStash' | 'listRetainedStashes' | 'getDiff' | 'getFileContents'>;
export interface SnapshotStorage {
  read(repositoryId: string, hash: string, layer: DiffLayer): Promise<SavedLayer | undefined>;
  write(repositoryId: string, hash: string, layer: DiffLayer, snapshot: SavedLayer): Promise<void>;
  remove(repositoryId:string,hash:string,layer:DiffLayer):Promise<void>;
}
export interface LibraryAdapter {
  getData(): PluginData;
  transaction(change: (draft: PluginData) => void): Promise<void>;
  storage: SnapshotStorage;
  warn?(message: string): void;
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const clone = <T>(value: T): T => structuredClone(value);
const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined => record && Object.hasOwn(record, key) ? record[key] : undefined;
const entryOf = (data: PluginData, id: string, hash: string): ReviewEntry | undefined => own(own(data.reviewCatalog, id), hash);
const catalogs = (data: PluginData): void => {data.repositoryCatalog ??= {}; data.reviewCatalog ??= {};};
const entryFor = (stash: Stash): ReviewEntry => ({stash: {...stash, archived: undefined, recoverable: undefined}, archived: false, snapshotLayers: [], fingerprints: {}});

function immutableFiles(files: DiffFile[]): DiffFile[] {
  for (const file of files) {
    for (const hunk of file.hunks) {for (const line of hunk.lines) Object.freeze(line); Object.freeze(hunk.lines); Object.freeze(hunk);}
    Object.freeze(file.hunks); Object.freeze(file);
  }
  Object.freeze(files); return files;
}

function concurrentMetadata(base: StashMetadata, proposed: StashMetadata, live: StashMetadata): StashMetadata {
  const next = clone(proposed);
  for (const key of ['title','description','tags','pinned','continuedFrom'] as const) {
    if (!equal(base[key], live[key])) Object.assign(next, {[key]: clone(live[key])});
  }
  next.reviewedByLayer = {};
  for (const layer of DIFF_LAYERS) {
    const original = new Set(reviewedPaths(base, layer)), current = new Set(reviewedPaths(live, layer)), result = new Set(reviewedPaths(proposed, layer));
    for (const path of original) if (!current.has(path)) result.delete(path);
    for (const path of current) if (!original.has(path)) result.add(path);
    next.reviewedByLayer[layer] = [...result];
  }
  next.reviewedFiles = next.reviewedByLayer.all!;
  const baseNotes = new Map(base.annotations.map(note => [note.id, note])), liveNotes = new Map(live.annotations.map(note => [note.id, note]));
  const notes = new Map(next.annotations.map(note => [note.id, note]));
  for (const id of baseNotes.keys()) if (!liveNotes.has(id)) notes.delete(id);
  for (const [id, note] of liveNotes) if (!equal(note, baseNotes.get(id))) notes.set(id, clone(note));
  next.annotations = [...notes.values()];
  return next;
}

/** One save queue for synchronous metadata edits and infrequent catalog transactions. */
export class DataTransactions {
  private pending: Promise<unknown> = Promise.resolve();
  private versions = new Map<string, number>();
  constructor(private getData: () => PluginData, private setData: (data: PluginData) => void, private saveData: (data: PluginData) => Promise<void>) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => undefined).then(operation);
    this.pending = next;
    return next;
  }
  persist(): Promise<void> {return this.enqueue(() => this.saveData(this.getData()));}
  saveMetadata(id: string, hash: string, metadata: StashMetadata): Promise<void> {
    const data = this.getData();
    if (!Object.hasOwn(data.reviews, id)) data.reviews[id] = {};
    data.reviews[id][hash] = clone(metadata);
    const key = JSON.stringify([id, hash]);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    return this.persist();
  }
  transaction(change: (draft: PluginData) => void): Promise<void> {
    return this.enqueue(async () => {
      const base = clone(this.getData()), proposed = clone(base), versions = new Map(this.versions);
      change(proposed);
      await this.saveData(proposed);
      const live = this.getData();
      for (const [key, version] of this.versions) if (versions.get(key) !== version) {
        const [id, hash] = JSON.parse(key) as [string, string];
        proposed.reviews[id] ??= {};
        proposed.reviews[id][hash] = concurrentMetadata(readMetadata(base, id, hash), readMetadata(proposed, id, hash), readMetadata(live, id, hash));
      }
      for (const key of Object.keys(live.settings) as Array<keyof PluginData['settings']>) {
        if (!equal(live.settings[key], base.settings[key])) Object.assign(proposed.settings, {[key]: clone(live.settings[key])});
      }
      this.setData(proposed);
    });
  }
}

export function diffBytes(files: DiffFile[]): number {
  return files.reduce((bytes, file) => bytes + 256 + file.path.length * 2 + (file.oldContent?.length ?? 0) * 2 + (file.newContent?.length ?? 0) * 2
    + file.hunks.reduce((size, hunk) => size + 128 + hunk.header.length * 2 + hunk.lines.reduce((sum, line) => sum + 128 + line.text.length * 2, 0), 0), 0);
}

function compatibleLayers(existing:SavedLayer,incoming:SavedLayer):boolean {
  if(existing.files.length!==incoming.files.length)return false;
  const files=new Map(existing.files.map(file=>[file.path,file]));
  for(const file of incoming.files) {
    const original=files.get(file.path);
    if(!original || (['oldPath','status','binary','untracked','oldMode','newMode','oldBlob','newBlob','fingerprint','additions','deletions'] as const).some(key=>original[key]!==file[key]))return false;
    for(const side of ['old','new'] as const) {
      const before=!original.truncated&&!original.sourceUnavailable ? original[side==='old'?'oldContent':'newContent'] : undefined;
      const after=!file.truncated&&!file.sourceUnavailable ? file[side==='old'?'oldContent':'newContent'] : undefined;
      if(before!==undefined && after!==undefined && before!==after)return false;
      const known=(before??after)?.split('\n'), observed=new Map<number,string>();
      for(const candidate of [original,file])for(const hunk of candidate.hunks)for(const line of hunk.lines) {
        const number=side==='old'?line.oldLine:line.newLine;if(number===undefined)continue;
        if(known && known[number-1]!==line.text || observed.has(number)&&observed.get(number)!==line.text)return false;
        observed.set(number,line.text);
      }
    }
  }
  return true;
}

export class ReviewLibrary {
  private reads: ReadCache;
  private pendingWrites = new Map<string, Promise<void>>();
  private reviewOperations=new Map<string,Promise<unknown>>();
  constructor(private adapter: LibraryAdapter, private gitSource: LibraryGit | (() => LibraryGit), reads?: ReadCache) {this.reads = reads ?? new ReadCache(16 * 1024 * 1024, 32);}
  private get git(): LibraryGit {return typeof this.gitSource === 'function' ? this.gitSource() : this.gitSource;}
  private operation<T>(id:string,hash:string,run:()=>Promise<T>):Promise<T> {
    const key=JSON.stringify([id,hash]), previous=this.reviewOperations.get(key)??Promise.resolve();
    const next=previous.catch(()=>undefined).then(run).finally(()=>{if(this.reviewOperations.get(key)===next)this.reviewOperations.delete(key);});
    this.reviewOperations.set(key,next);return next;
  }
  private key(kind: string, id: string, hash = '', layer: DiffLayer = 'all', extra: unknown = ''): string {return JSON.stringify([kind,id,hash,layer,extra]);}
  private async saved(id: string, hash: string, layer: DiffLayer): Promise<SavedLayer | undefined> {
    return this.reads.read(this.key('saved',id,hash,layer), () => this.adapter.storage.read(id,hash,layer), value => value ? diffBytes(value.files) + 64 : 0);
  }
  private writeSnapshot(id: string, hash: string, layer: DiffLayer, snapshot: SavedLayer): Promise<void> {
    const key = this.key('saved',id,hash,layer);
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const writing = previous.catch(() => undefined).then(async () => {
      const existing = await this.saved(id,hash,layer);
      const richer = existing && existing.context > snapshot.context ? existing : snapshot;
      const supplemental = richer === snapshot ? existing : snapshot;
      const sources = new Map(supplemental?.files.map(file => [file.path,file]) ?? []);
      const selected = {...richer,files:richer.files.map(file => {
        if (file.oldContent !== undefined && file.newContent !== undefined && !file.truncated) return file;
        const enriched = sources.get(file.path);
        return enriched?.oldContent !== undefined && enriched.newContent !== undefined && !enriched.truncated && enriched.fingerprint === file.fingerprint
          ? {...file,oldContent:enriched.oldContent,newContent:enriched.newContent,truncated:undefined} : file;
      })};
      if (!existing || !equal(existing, selected)) {
        await this.adapter.storage.write(id,hash,layer,selected);
        this.reads.invalidate(key);
      }
    }).finally(() => {if (this.pendingWrites.get(key) === writing) this.pendingWrites.delete(key);});
    this.pendingWrites.set(key,writing);
    return writing;
  }
  async registerRepository(repository: Repository, configuredPath?: string): Promise<Repository> {
    const find=(data:PluginData)=>Object.values(data.repositoryCatalog??{}).find(binding=>binding.paths.includes(repository.path)||!!configuredPath&&binding.paths.includes(configuredPath)||(binding.gitId??binding.id)===repository.id);
    let binding=find(this.adapter.getData());
    if(!binding || binding.gitId!==repository.id || !binding.paths.includes(repository.path) || !!configuredPath&&!binding.paths.includes(configuredPath)) await this.adapter.transaction(draft=>{
      catalogs(draft);const existing=find(draft);
      const id=existing?.id ?? (own(draft.repositoryCatalog,repository.id)?`${repository.id.slice(0,200)}-${crypto.randomUUID()}`:repository.id);
      binding={id,name:existing?.name??repository.name,gitId:repository.id,paths:[...new Set([...(existing?.paths??[]),repository.path,...(configuredPath?[configuredPath]:[])])]};
      draft.repositoryCatalog![id]=binding;
    });
    return {...repository,id:binding!.id,name:binding!.name};
  }
  async relocateRepository(id: string, path: string): Promise<Repository> {
    const binding = own(this.adapter.getData().repositoryCatalog,id);
    if (!binding) throw new Error('Choose an existing repository to relocate.');
    const resolved = await this.git.resolveRepository(path);
    const conflicting = Object.values(this.adapter.getData().repositoryCatalog ?? {}).find(value => value.id !== id && (value.paths.includes(resolved.path)||(value.gitId??value.id)===resolved.id));
    if (conflicting) throw new Error('That folder is already bound to another review repository.');
    await this.adapter.transaction(draft => {
      catalogs(draft);
      const current=own(draft.repositoryCatalog,id)!;
      if(Object.values(draft.repositoryCatalog!).some(value=>value.id!==id&&(value.paths.includes(resolved.path)||(value.gitId??value.id)===resolved.id)))throw new Error('That folder is already bound to another review repository.');
      const oldPaths = new Set(current.paths), paths = draft.settings.repositories.filter(value => !oldPaths.has(value));
      draft.settings.repositories = [...new Set([...paths,resolved.path])];
      draft.repositoryCatalog![id] = {...current,gitId:resolved.id, paths: [resolved.path]};
    });
    this.reads.clear();
    return {...resolved,id,name: binding.name};
  }
  private async capture(repository: Repository, stash: Stash, layer: DiffLayer, snapshot: SavedLayer): Promise<void> {
    await this.writeSnapshot(repository.id,stash.hash,layer,snapshot);
    const existing = entryOf(this.adapter.getData(),repository.id,stash.hash);
    const fingerprints = Object.fromEntries(snapshot.files.filter(file => file.fingerprint).map(file => [file.path,file.fingerprint!]));
    if (existing?.snapshotLayers.includes(layer) && equal(existing.fingerprints[layer], fingerprints)) return;
    await this.adapter.transaction(draft => {
      catalogs(draft); draft.reviewCatalog![repository.id] ??= {};
      const entry = entryOf(draft,repository.id,stash.hash) ?? entryFor(stash);
      draft.reviewCatalog![repository.id][stash.hash] = {...entry, stash: {...stash,archived:undefined,recoverable:undefined},
        snapshotLayers: [...new Set([...entry.snapshotLayers,layer])], fingerprints: {...entry.fingerprints,[layer]:fingerprints}};
    });
  }
  async getDiff(repository: Repository, stash: Stash, layer: DiffLayer, context: number): Promise<DiffFile[]> {
    return this.reads.read(this.key(repository.offline ? 'offline-diff' : 'diff',repository.id,stash.hash,layer,context), () => this.operation(repository.id,stash.hash,async () => {
      let files: DiffFile[] | undefined;
      if (!repository.offline) {
        try {await this.git.retainStash(repository,stash); files = await this.git.getDiff(repository,stash,layer,context);}
        catch { /* Retained snapshots remain usable after moving or removing a repository. */ }
      }
      if (files) {
        await this.capture(repository,stash,layer,{context,files}).catch(error => this.adapter.warn?.(`The Git snapshot is retained, but its review copy could not be saved: ${error instanceof Error ? error.message : String(error)}`));
        return immutableFiles(files);
      }
      const saved = await this.saved(repository.id,stash.hash,layer);
      if (!saved) throw new Error('This diff layer was not captured and its Git object is unavailable. Your review notes are preserved.');
      return immutableFiles(saved.files);
    }),diffBytes);
  }
  async getFileContents(repository: Repository, stash: Stash, file: DiffFile, layer: DiffLayer): Promise<{oldContent: string; newContent: string; truncated?: boolean}> {
    return this.reads.read(this.key('source',repository.id,stash.hash,layer,[file.path,file.fingerprint]),() => this.operation(repository.id,stash.hash,async () => {
      if (file.oldContent !== undefined && file.newContent !== undefined) return {oldContent:file.oldContent,newContent:file.newContent,truncated:file.truncated};
      let source: {oldContent: string; newContent: string; truncated?: boolean} | undefined;
      if (!repository.offline) {
        try {source = await this.git.getFileContents(repository,stash,file,layer);} catch { /* Fall back to captured source. */ }
      }
      const saved = await this.saved(repository.id,stash.hash,layer);
      if (source) {
        if (saved && !source.truncated && file.oldMode !== '160000' && file.newMode !== '160000') await this.writeSnapshot(repository.id,stash.hash,layer,{...saved,files:saved.files.map(value => value.path === file.path ? {...value,...source} : value)}).catch(error => this.adapter.warn?.(String(error)));
        return source;
      }
      const captured = saved?.files.find(value => value.path === file.path);
      if (captured?.oldContent !== undefined && captured.newContent !== undefined) return {oldContent:captured.oldContent,newContent:captured.newContent,truncated:captured.truncated};
      throw new Error('Full-file source was not included in this saved review. The captured diff and notes remain available.');
    }),source => 128 + (source.oldContent.length + source.newContent.length) * 2);
  }
  async archiveReview(repository: Repository, stash: Stash, archived: boolean): Promise<void> {
    if (!repository.offline) await this.git.retainStash(repository,stash);
    await this.adapter.transaction(draft => {
      catalogs(draft); draft.reviewCatalog![repository.id] ??= {};
      draft.reviewCatalog![repository.id][stash.hash] = {...(entryOf(draft,repository.id,stash.hash) ?? entryFor(stash)), archived};
    });
  }
  async listArchivedReviews(repository: Repository): Promise<Stash[]> {
    const [liveResult, retainedResult] = repository.offline ? [{status:'fulfilled',value:[]} as PromiseFulfilledResult<Stash[]>,{status:'fulfilled',value:[]} as PromiseFulfilledResult<Stash[]>]
      : await Promise.allSettled([this.git.listStashes(repository),this.git.listRetainedStashes(repository)]);
    const live = new Set(liveResult.status === 'fulfilled' ? liveResult.value.map(value => value.hash) : []);
    const retained = new Map(retainedResult.status === 'fulfilled' ? retainedResult.value.map(value => [value.hash,value] as const) : []);
    const data = this.adapter.getData(), entries = own(data.reviewCatalog,repository.id) ?? {}, archived = new Map<string, Stash>();
    for (const [hash, entry] of Object.entries(entries)) if (entry.archived || !live.has(hash)) archived.set(hash,{...entry.stash,ref:'Archived',archived:true,recoverable:retained.has(hash),inStashList:live.has(hash)});
    for (const [hash, stash] of retained) if (!live.has(hash) && !archived.has(hash)) archived.set(hash,{...stash,archived:true,recoverable:true,inStashList:false});
    for (const hash of Object.keys(own(data.reviews,repository.id) ?? {})) if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash) && !live.has(hash) && !archived.has(hash)) {
      const metadata = readMetadata(data,repository.id,hash);
      archived.set(hash,{hash,ref:'Archived',message:metadata.title || 'Saved review',branch:'',createdAt:'',baseHash:'',archived:true,recoverable:false,inStashList:false});
    }
    return [...archived.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  async listActiveStashes(repository: Repository): Promise<Stash[]> {
    if (repository.offline) return [];
    const stashes = await this.git.listStashes(repository), data = this.adapter.getData();
    return stashes.filter(stash => !entryOf(data,repository.id,stash.hash)?.archived);
  }
  async withExcerpts(repository: Repository, stash: Stash, original: StashMetadata): Promise<StashMetadata> {
    const metadata = clone(original), filesByLayer = new Map<DiffLayer, DiffFile[]>();
    for (const annotation of metadata.annotations) {
      if (annotation.excerpt) continue;
      try {
        let files = filesByLayer.get(annotation.layer);
        if (!files) {files = await this.getDiff(repository,stash,annotation.layer,5); filesByLayer.set(annotation.layer,files);}
        const file = files.find(value => value.path === annotation.path);
        if (!file || file.binary) continue;
        const source = await this.getFileContents(repository,stash,file,annotation.layer);
        if (source.truncated) continue;
        const lines = (annotation.side === 'old' ? source.oldContent : source.newContent).split('\n');
        if (annotation.endLine <= lines.length) annotation.excerpt = {text:lines.slice(annotation.startLine - 1,annotation.endLine).join('\n'),startLine:annotation.startLine};
      } catch { /* Export the discussion with an explicit missing-code note. */ }
    }
    return metadata;
  }
  async continueReview(repository: Repository, stash: Stash, predecessorHash: string): Promise<void> {
    if (predecessorHash === stash.hash) throw new Error('Choose a different original review.');
    const previous = entryOf(this.adapter.getData(),repository.id,predecessorHash);
    if (!previous) throw new Error('The original review is unavailable.');
    const matching: Partial<Record<DiffLayer, ReadonlySet<string>>> = {};
    for (const layer of DIFF_LAYERS) {
      try {
        if (repository.offline) continue;
        const [oldFiles,newFiles] = await Promise.all([this.git.getDiff(repository,previous.stash,layer,5),this.getDiff(repository,stash,layer,5)]);
        const originals = new Map(oldFiles.map(file => [file.path,file.fingerprint]));
        matching[layer] = new Set(newFiles.filter(file => file.fingerprint && originals.get(file.path) === file.fingerprint).map(file => file.path));
      } catch { /* Unverifiable legacy comments remain on their original snapshot. */ }
    }
    await this.adapter.transaction(draft => {
      const current = readMetadata(draft,repository.id,stash.hash), original = readMetadata(draft,repository.id,predecessorHash);
      draft.reviews[repository.id] ??= {};
      draft.reviews[repository.id][stash.hash] = continueMetadata(original,current,matching,predecessorHash);
      catalogs(draft); draft.reviewCatalog![repository.id] ??= {};
      const entry = entryOf(draft,repository.id,stash.hash) ?? entryFor(stash);
      draft.reviewCatalog![repository.id][stash.hash] = {...entry,predecessorHash};
      const previousEntry = entryOf(draft,repository.id,predecessorHash);
      if (previousEntry) previousEntry.archived = true;
    });
  }
  async exportReviewData(repository: Repository, stash: Stash): Promise<string> {
    const layers = {} as Record<DiffLayer, SavedLayer>;
    for (const layer of DIFF_LAYERS) {
      const files = await this.getDiff(repository,stash,layer,5);
      const saved = await this.saved(repository.id,stash.hash,layer);
      layers[layer] = saved ?? {context:5,files};
    }
    const metadata = readMetadata(this.adapter.getData(),repository.id,stash.hash);
    for (const annotation of metadata.annotations) {
      if (annotation.excerpt) continue;
      const file = layers[annotation.layer].files.find(value => value.path === annotation.path);
      if (!file || file.binary) continue;
      try {
        const source = await this.getFileContents(repository,stash,file,annotation.layer);
        if (source.truncated) continue;
        const text = annotation.side === 'old' ? source.oldContent : source.newContent;
        const lines = text.split('\n');
        if (annotation.endLine <= lines.length) annotation.excerpt = {text:lines.slice(annotation.startLine - 1,annotation.endLine).join('\n'),startLine:annotation.startLine};
        layers[annotation.layer] = {...layers[annotation.layer],files:layers[annotation.layer].files.map(value => value.path === file.path ? {...value,...source} : value)};
      } catch { /* Keep the discussion when full source was never captured. */ }
    }
    return serializePortableReview({format:'stash-review',version:1,repository:{id:repository.id,name:repository.name},stash,metadata,layers});
  }
  async importReviewData(source: string, repositoryId?: string): Promise<ReviewTarget> {
    const review = parsePortableReview(source), id = repositoryId ?? review.repository.id;
    if (!validRepositoryId(id) || repositoryId && !own(this.adapter.getData().repositoryCatalog,id)) throw new Error('Choose a configured local repository, or import into the saved review library.');
    return this.operation(id,review.stash.hash,async()=>{
    const existing = own(own(this.adapter.getData().reviews,id),review.stash.hash);
    if (existing && !equal(readMetadata(this.adapter.getData(),id,review.stash.hash),review.metadata)) throw new Error('Import conflict: existing review notes differ. Export the local review before importing another version.');
    const before=new Map<DiffLayer,SavedLayer|undefined>(), written:DiffLayer[]=[];
    for (const layer of DIFF_LAYERS) {
      const captured = await this.saved(id,review.stash.hash,layer);
      before.set(layer,captured);
      if(captured&&!compatibleLayers(captured,review.layers[layer]))throw new Error('Import conflict: captured code differs for this stash hash. Existing snapshots and notes were kept.');
    }
    try {
    for(const layer of DIFF_LAYERS)if(!before.get(layer)){written.push(layer);await this.writeSnapshot(id,review.stash.hash,layer,review.layers[layer]);}
    await this.adapter.transaction(draft => {
      const local = own(own(draft.reviews,id),review.stash.hash);
      if (local && !equal(readMetadata(draft,id,review.stash.hash),review.metadata)) throw new Error('Import conflict: the local review changed while importing.');
      catalogs(draft);
      draft.repositoryCatalog![id] ??= {id,name:review.repository.name,paths:[]};
      draft.reviews[id] ??= {};
      if (!local) draft.reviews[id][review.stash.hash] = clone(review.metadata);
      draft.reviewCatalog![id] ??= {};
      const oldEntry = entryOf(draft,id,review.stash.hash);
      draft.reviewCatalog![id][review.stash.hash] = {...(oldEntry??{...entryFor(review.stash),archived:true}),snapshotLayers:[...DIFF_LAYERS],
        fingerprints:Object.fromEntries(DIFF_LAYERS.map(layer => [layer,Object.fromEntries((before.get(layer)??review.layers[layer]).files.filter(file => file.fingerprint).map(file => [file.path,file.fingerprint!]))]))};
    });
    } catch(error) {
      const failures=await Promise.allSettled(written.map(async layer=>{
        await this.adapter.storage.remove(id,review.stash.hash,layer);this.reads.invalidate(this.key('saved',id,review.stash.hash,layer));
      }));
      if(failures.some(result=>result.status==='rejected'))throw new Error(`Import failed and its temporary snapshots could not all be removed. Existing notes were kept. ${error instanceof Error?error.message:String(error)}`);
      throw error;
    }
    return {repositoryId:id,stashHash:review.stash.hash,layer:'all'};
    });
  }
  clear(): void {this.reads.clear();}
}
