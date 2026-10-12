import {describe, expect, it} from 'vitest';
import {DataTransactions, ReviewLibrary, type LibraryGit, type SnapshotStorage} from '../src/review-library';
import {loadPluginData, readMetadata} from '../src/review-store';
import {emptyMetadata, type DiffFile, type PluginData, type Repository, type SavedLayer, type Stash} from '../src/types';

const repo: Repository = {id: 'repo', name: 'Notes', path: 'C:/original', branch: 'main', dirty: false};
const stash: Stash = {hash: 'a'.repeat(40), baseHash: 'b'.repeat(40), ref: 'stash@{0}', message: 'Retain idea', branch: 'main', createdAt: '2026-10-12T10:00:00Z'};
const file: DiffFile = {path: 'app.ts', status: 'modified', additions: 1, deletions: 1, binary: false, untracked: false,
  oldBlob: 'b'.repeat(40), newBlob: 'c'.repeat(40), oldMode: '100644', newMode: '100644', fingerprint: JSON.stringify(['100644','b'.repeat(40),'100644','c'.repeat(40),'app.ts','app.ts',false]),
  oldContent: 'old\n', newContent: 'new\n', hunks: [{header: '@@ -1 +1 @@', oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [{type: 'delete', oldLine: 1, text: 'old'}, {type: 'add', newLine: 1, text: 'new'}]}]};

function fixture() {
  let data = loadPluginData({settings: {repositories: [repo.path]}, repositoryCatalog: {repo: {id: 'repo', name: 'Notes', paths: [repo.path]}}});
  let persisted = structuredClone(data), reject = false, block: Promise<void> | undefined;
  let live = [stash], available = true, full = true, snapshotReads = 0, snapshotWrites = 0, gitReads = 0;
  const snapshots = new Map<string, SavedLayer>(), retained = new Map<string, Stash>();
  const writes = new DataTransactions(() => data, value => {data = value;}, async value => {
    if (block) await block;
    if (reject) throw new Error('Disk full');
    persisted = structuredClone(value);
  });
  const storage: SnapshotStorage = {
    async read(id, hash, layer) {snapshotReads++; return structuredClone(snapshots.get(JSON.stringify([id,hash,layer])));},
    async write(id, hash, layer, value) {snapshotWrites++; snapshots.set(JSON.stringify([id,hash,layer]), structuredClone(value));}
  };
  const git: LibraryGit = {
    async resolveRepository(path) {if (path === 'bad') throw new Error('Not a Git repository'); return {...repo, id: 'physical-id', path};},
    async listStashes() {if (!available) throw new Error('Repository unavailable'); return live;},
    async retainStash(_repo, value) {if (!available) throw new Error('Repository unavailable'); retained.set(value.hash, value);},
    async listRetainedStashes() {if (!available) throw new Error('Repository unavailable'); return [...retained.values()];},
    async getDiff(_repo, _stash, layer) {gitReads++; if (!available) throw new Error('Repository unavailable'); return layer === 'staged' ? [] : [full ? structuredClone(file) : {...structuredClone(file),oldContent:undefined,newContent:undefined}];},
    async getFileContents() {if (!available) throw new Error('Repository unavailable'); return {oldContent: 'old\n', newContent: 'new\n'};}
  };
  const library = new ReviewLibrary({getData: () => data, transaction: change => writes.transaction(change), storage}, git);
  return {library, writes, storage, snapshots, git, data: () => data, persisted: () => persisted,
    unavailable: () => {available = false;}, rawDiff: () => {full = false;}, drop: () => {live = [];}, reject: (value: boolean) => {reject = value;}, block: (value?: Promise<void>) => {block = value;},
    counts: () => ({snapshotReads,snapshotWrites,gitReads})};
}

describe('durable review library', () => {
  it('continues an explicitly chosen revision only for exact fingerprints in each layer', async () => {
    const f=fixture(), revised={...stash,hash:'d'.repeat(40)}, original=structuredClone(file);
    f.git.getDiff=async (_repo,target,layer)=>[target.hash===revised.hash && layer==='staged' ? {...structuredClone(original),fingerprint:'different-index'} : structuredClone(original)];
    await f.library.getDiff(repo,stash,'all',5);
    const note={id:'all-note',path:'app.ts',side:'new' as const,layer:'all' as const,startLine:1,endLine:1,body:'Keep original code',createdAt:'',updatedAt:'',resolved:false,replies:[]};
    const metadata={...emptyMetadata(),title:'Original title',reviewedByLayer:{all:['app.ts'],staged:['app.ts']},annotations:[note,{...note,id:'index-note',layer:'staged' as const}]};
    await f.writes.saveMetadata(repo.id,stash.hash,metadata);
    await f.library.continueReview(repo,revised,stash.hash);
    const next=readMetadata(f.data(),repo.id,revised.hash);
    expect(next.annotations.map(value=>value.id)).toEqual(['all-note']);
    expect(next.reviewedByLayer?.all).toEqual(['app.ts']);expect(next.reviewedByLayer?.staged).toEqual([]);
    expect(next.continuedFrom).toBe(stash.hash);
    expect(readMetadata(f.data(),repo.id,stash.hash).annotations).toEqual(metadata.annotations);
    expect(f.data().reviewCatalog!.repo[stash.hash].archived).toBe(true);
  });
  it('records configured path aliases so relocation removes old settings spellings', async () => {
    const f = fixture();
    f.data().settings.repositories = ['C:\\original'];
    await f.library.registerRepository(repo, 'C:\\original');
    await f.library.relocateRepository('repo','C:/moved');
    expect(f.data().settings.repositories).toEqual(['C:/moved']);
  });
  it('keeps previously captured source when a later read supplies only richer diff context', async () => {
    const f = fixture();
    await f.library.getDiff(repo,stash,'all',5);
    f.rawDiff();
    await f.library.getDiff(repo,stash,'all',20);
    const saved = await f.storage.read('repo',stash.hash,'all');
    expect(saved!.context).toBe(20);
    expect(saved!.files[0].oldContent).toBe('old\n');
    expect(saved!.files[0].newContent).toBe('new\n');
  });
  it('reopens an externally dropped review using retained objects and offline snapshots', async () => {
    const f = fixture();
    await f.library.getDiff(repo, stash, 'all', 5);
    f.drop();
    expect((await f.library.listArchivedReviews(repo))[0]).toMatchObject({hash: stash.hash, recoverable: true});
    f.unavailable();
    const offline = {...repo, offline: true};
    expect((await f.library.getDiff(offline, stash, 'all', 5))[0].hunks[0].lines[1].text).toBe('new');
    await expect(f.library.getDiff(offline, stash, 'staged', 5)).rejects.toThrow(/captured|saved|layer/i);
  });
  it('archives a live stash without dropping it and restores its active review state', async () => {
    const f = fixture();
    await f.library.getDiff(repo, stash, 'all', 5);
    await f.library.archiveReview(repo, stash, true);
    expect((await f.library.listArchivedReviews(repo)).map(value => value.hash)).toEqual([stash.hash]);
    await f.library.archiveReview(repo, stash, false);
    expect(await f.library.listArchivedReviews(repo)).toEqual([]);
  });
  it('relocates a repository without losing its logical ID or review metadata', async () => {
    const f = fixture();
    await f.writes.saveMetadata('repo', stash.hash, {...emptyMetadata(), title: 'Keep my title'});
    const moved = await f.library.relocateRepository('repo', 'C:/moved');
    expect(moved).toMatchObject({id: 'repo', path: 'C:/moved'});
    expect(readMetadata(f.data(), 'repo', stash.hash).title).toBe('Keep my title');
    expect(f.data().settings.repositories).toEqual(['C:/moved']);
    const before = structuredClone(f.data());
    await expect(f.library.relocateRepository('repo', 'bad')).rejects.toThrow();
    expect(f.data()).toEqual(before);
  });
  it('coalesces immutable reads and does not load other archives while browsing their descriptors', async () => {
    const f = fixture();
    await Promise.all(Array.from({length: 6}, () => f.library.getDiff(repo, stash, 'all', 5)));
    expect(f.counts().gitReads).toBe(1);
    expect(f.counts().snapshotWrites).toBe(1);
    f.drop();
    const before = f.counts().snapshotReads;
    await f.library.listArchivedReviews(repo);
    expect(f.counts().snapshotReads).toBe(before);
  });
  it('imports portable code into an offline library without invoking Git', async () => {
    const source = fixture();
    const portable = await source.library.exportReviewData(repo, stash);
    const target = fixture(); target.unavailable();
    const destination = await target.library.importReviewData(portable);
    expect(destination).toMatchObject({repositoryId: 'repo', stashHash: stash.hash});
    expect(target.data().reviewCatalog!.repo[stash.hash].archived).toBe(true);
    expect(target.counts().gitReads).toBe(0);
    expect((await target.library.getDiff({...repo, offline: true}, stash, 'all', 5))[0].newContent).toBe('new\n');
  });
  it('deduplicates identical imports and refuses to overwrite different local notes', async () => {
    const source = fixture();
    const portable = await source.library.exportReviewData(repo, stash);
    const target = fixture();
    await target.library.importReviewData(portable, 'repo');
    await target.library.importReviewData(portable, 'repo');
    expect(Object.keys(target.data().reviewCatalog!.repo)).toEqual([stash.hash]);
    await target.writes.saveMetadata('repo', stash.hash, {...emptyMetadata(), title: 'Local decision'});
    const before = structuredClone(target.data());
    await expect(target.library.importReviewData(portable, 'repo')).rejects.toThrow(/conflict/i);
    expect(target.data()).toEqual(before);
  });
  it('preserves an independent annotation edit while a catalog write is pending', async () => {
    const f = fixture();
    const other = 'e'.repeat(40);
    await f.writes.saveMetadata('repo', other, {...emptyMetadata(), title: 'Before'});
    let release!: () => void;
    f.block(new Promise<void>(resolve => {release = resolve;}));
    const transaction = f.writes.transaction((draft: PluginData) => {draft.repositoryCatalog!.repo.name = 'Imported label';});
    await Promise.resolve(); await Promise.resolve();
    const edit = f.writes.saveMetadata('repo', other, {...emptyMetadata(), title: 'Independent edit'});
    f.block(); release();
    await Promise.all([transaction, edit]);
    expect(readMetadata(f.persisted(), 'repo', other).title).toBe('Independent edit');
    expect(f.persisted().repositoryCatalog!.repo.name).toBe('Imported label');
  });
  it('rolls back a failed catalog/import write while leaving existing notes usable', async () => {
    const source = fixture();
    const portable = await source.library.exportReviewData(repo, stash);
    const target = fixture();
    await target.writes.saveMetadata('repo', 'e'.repeat(40), {...emptyMetadata(), title: 'Local notes'});
    const before = structuredClone(target.data()); target.reject(true);
    await expect(target.library.importReviewData(portable, 'repo')).rejects.toThrow('Disk full');
    expect(target.data()).toEqual(before);
    target.reject(false);
    await target.library.importReviewData(portable, 'repo');
    expect(readMetadata(target.data(), 'repo', 'e'.repeat(40)).title).toBe('Local notes');
  });
  it('preserves newly transferred comments while replaying an independent deletion', async () => {
    const f = fixture();
    const annotation = {id:'original',path:'app.ts',side:'new' as const,layer:'all' as const,startLine:1,endLine:1,body:'Original',createdAt:'',updatedAt:'',resolved:false,replies:[]};
    await f.writes.saveMetadata('repo',stash.hash,{...emptyMetadata(),annotations:[annotation]});
    let release!: () => void;
    f.block(new Promise<void>(resolve => {release = resolve;}));
    const transaction = f.writes.transaction(draft => {
      draft.reviews.repo[stash.hash] = {...draft.reviews.repo[stash.hash],annotations:[annotation,{...annotation,id:'transferred',body:'Transferred'}]};
    });
    await Promise.resolve(); await Promise.resolve();
    const edit = f.writes.saveMetadata('repo',stash.hash,{...emptyMetadata(),annotations:[{...annotation,id:'independent',body:'Independent'}]});
    f.block(); release();
    await Promise.all([transaction,edit]);
    expect(readMetadata(f.persisted(),'repo',stash.hash).annotations.map(note => note.id)).toEqual(['transferred','independent']);
  });
});
