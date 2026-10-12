# Durable Reviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the recommended inline execution, or superpowers:subagent-driven-development if the user chooses delegation. Implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and recover stash reviews, isolate progress by layer, move and exchange reviews, render Obsidian Markdown, and search changes without losing context when a stash is replaced.

**Architecture:** Keep immutable Git identity underneath one versioned review catalog. Keep code snapshots outside frequently saved metadata, expose optional library capabilities through the existing ReviewHost, and derive search/noise presentation from cached canonical diffs. Existing read coalescing and deferred rendering are reused wherever the concurrent performance work has supplied them.

**Tech Stack:** TypeScript, React 19, Obsidian desktop API, Node.js built-ins including zlib and fs/promises, Git, Vitest and Playwright; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-durable-reviews-design.md`.

## Global Constraints

- Use Node.js 22, TypeScript, React 19, and Obsidian desktop 1.6 or later. Add no runtime dependencies.
- A review belongs to a logical repository ID and an immutable full stash commit hash.
- Existing path-only viewed flags belong to the All layer; they must not imply review of the Staged or Unstaged layers.
- Keep the existing `reviewedFiles` field as a compatibility representation of All progress so old fixtures and the user's benchmark host keep working.
- Never infer a successor from its reflog index or message.
- The uncompressed limit is 32 MiB per package.
- Bound the new immutable-read cache to 16 MiB and 32 entries.
- Search is debounced by 100 ms and reuses a per-snapshot index.
- Archive lists render in pages of 50 entries without loading snapshot contents or rendering Markdown for every archived item.
- Large diffs render progressively in chunks of 200 rows rather than eagerly mounting thousands of code rows.
- Preserve all unrelated working-tree changes. Do not bump versions, tag, publish, or create a release as part of this implementation.

## Review Focus

1. A replaced stash reuses a reflog index or message, while unchanged and changed files coexist: carry only exact layer/file matches and retain every original comment. Owned by Tasks 1, 2 and 5.
2. Import or relocation overlaps an annotation save in another embed: preserve the independent edit, keep shared metadata coherent, and roll back a failed catalog transaction. Owned by Tasks 3 and 5.
3. A portable package is malformed, oversized, internally inconsistent, or conflicts with local notes: reject it before changing existing data or executing Git. Owned by Task 3.
4. A hidden whitespace-only change or deferred distant row has an annotation/search result; code contains Unicode, literal HTML and Markdown fences: reveal original coordinates and preserve exact copy/export text. Owned by Tasks 4 and 5.
5. A relocated linked worktree or offline archive lacks a Git object or captured layer: retain identity and notes, identify missing code accurately, and disable unsupported mutations. Owned by Tasks 2, 3 and 5.

## Starting state and file manifest

The approved spec's file-by-file manifest remains the scope. A subsequent read-only inspection found concurrent performance edits to `src/git.ts`, `src/main.ts`, `src/ui/DiffView.tsx`, `src/ui/FileTree.tsx`, `src/ui/ReviewApp.tsx`, `styles.css`, `README.md`, and `tests/package-smoke.mjs`, plus new `src/read-cache.ts`, `src/ui/DeferredBlock.tsx`, `tests/read-cache.test.ts`, `tests/e2e/performance.spec.ts` and benchmark files. None of those changes were made by this plan's author.

Before execution, record the exact starting commit and changed-file hashes in the execution ledger. In an isolated worktree, implement from its confirmed starting commit and integrate the completed performance work when available, preserving both feature sets. In the current checkout, re-read and preserve the existing cache and deferred-rendering APIs before any edit. Do not overwrite an actively changing source file or stage another task's changes.

Manifest adjustment: `src/read-cache.ts` and `tests/read-cache.test.ts` are now existing files when the performance work is included; reuse/extend them. `src/ui/DeferredBlock.tsx` and `tests/e2e/performance.spec.ts` are reused for deferred mounting and regression verification; preserve their supplied behavior. Do not change the existing benchmark scripts or package script. Add `scripts/benchmark-durable-reviews.mjs` for this feature's additional measurements.

The tasks form one dependent sequence: typed migration -> immutable Git facts -> catalog/storage -> search/Markdown -> native and preview integration -> complete verification. This is one shared subsystem rather than five independent projects.

Before Task 1 source edits, collect the execution baseline with the supplied runner: `npm run benchmark -- --section compute --samples 5 --output benchmarks/results/durable-before-compute.json`, then the corresponding `--section git` and `--section browser` commands with unique `durable-before-git.json` and `durable-before-browser.json` paths. Refuse to overwrite an existing report. Record the exact source SHA, viewport and CPU settings. In an isolated checkout without the supplied untracked runner, run it from its original checkout against a verified committed `--ref`, or copy its read-only source into plan-owned scratch. Restore that same baseline configuration for Task 6 comparisons.

## Task 1: Layer-aware metadata and conservative revision continuation

**Files:** Modify `src/types.ts`, `src/review-store.ts`, `tests/review-store.test.ts`. Inspect compatibility consumers in `preview/fixtures.ts`, `tests/package-smoke.mjs`, `tests/e2e/review.spec.ts`, `tests/e2e/integration.spec.ts`, and the benchmark fixtures without changing the benchmark files.

**Consumes:** Existing StashMetadata, Annotation, DiffFile, PluginData and readMetadata.

**Produces:** `reviewedPaths(metadata: StashMetadata, layer: DiffLayer): string[]`; `withReviewedPath(metadata: StashMetadata, layer: DiffLayer, path: string, viewed: boolean): StashMetadata`; `continueMetadata(previous: StashMetadata, current: StashMetadata, matching: Partial<Record<DiffLayer, ReadonlySet<string>>>, predecessorHash: string): StashMetadata`. New optional metadata fields are `reviewedByLayer`, `fileFingerprints`, `continuedFrom`, and annotation `excerpt`. New DiffFile fields are optional `fingerprint`, `oldBlob`, `newBlob`, `oldMode`, `newMode`, and `sourceUnavailable`. PluginData accepts version 1 or 2; loadPluginData emits version 2 with initialized optional catalogs.

Catalog contracts:

```ts
export interface RepositoryBinding { id: string; name: string; paths: string[] }
export interface ReviewEntry {
  stash: Stash; archived: boolean; snapshotLayers: DiffLayer[];
  fingerprints: Partial<Record<DiffLayer, Record<string, string>>>;
  predecessorHash?: string;
}
export interface SavedLayer { context: number; files: DiffFile[] }
// PluginData adds repositoryCatalog and reviewCatalog; old direct fixtures
// remain accepted through optional fields and version: 1 | 2.
```

- [ ] **Step 1: Add migration and layer tests before implementation.**

```ts
it('migrates legacy viewed flags only to All', () => {
  const data = loadPluginData({version: 1, reviews: {repo: {hash: {
    ...emptyMetadata(), title: 'Keep', reviewedFiles: ['app.ts']
  }}}});
  const metadata = readMetadata(data, 'repo', 'hash');
  expect(data.version).toBe(2);
  expect(reviewedPaths(metadata, 'all')).toEqual(['app.ts']);
  expect(reviewedPaths(metadata, 'staged')).toEqual([]);
  expect(reviewedPaths(metadata, 'unstaged')).toEqual([]);
  const staged = withReviewedPath(metadata, 'staged', 'index.ts', true);
  expect(reviewedPaths(staged, 'staged')).toEqual(['index.ts']);
  expect(staged.reviewedFiles).toEqual(['app.ts']);
  expect(metadata.title).toBe('Keep');
});
```

Add tests named `continues only exact matching layer files`, `keeps changed-file and unverified legacy comments on the predecessor`, `does not mutate either revision`, and `preserves replies and independent current notes`. Build annotations from the existing test fixture, with a staged comment on an unchanged path and an unstaged comment on a changed path; matching sets differ by layer. Assert the predecessor retains both comments and only the staged comment appears on the successor.

- [ ] **Step 2: Run the new tests red.** Run `npm test -- tests/review-store.test.ts`. Expected: missing helper exports and version/layer assertions fail; existing preservation tests remain applicable.

- [ ] **Step 3: Implement the additive model migration and helpers.** Use this complete compatibility rule:

```ts
export function reviewedPaths(metadata: StashMetadata, layer: DiffLayer): string[] {
  return metadata.reviewedByLayer?.[layer]
    ?? (layer === 'all' ? metadata.reviewedFiles : []);
}
export function withReviewedPath(metadata: StashMetadata, layer: DiffLayer, path: string, viewed: boolean): StashMetadata {
  const paths = new Set(reviewedPaths(metadata, layer));
  if (viewed) paths.add(path); else paths.delete(path);
  const next = [...paths];
  return {...metadata, reviewedByLayer: {...metadata.reviewedByLayer, [layer]: next},
    reviewedFiles: layer === 'all' ? next : metadata.reviewedFiles};
}
```

Normalize optional layer arrays, fingerprints, catalog entries and excerpts when loading. Reject invalid anchors without dropping valid neighboring annotations. continuation unions current and transferred progress, preserves current text fields when already populated, and adds original comments only when matching contains their case-sensitive path in their saved layer. The caller constructs matching only from verified canonical before/after fingerprint equality; unverifiable legacy files never enter it. Record continuedFrom. Deduplicate comment IDs; never mutate either input. Store predecessor data separately rather than moving it.

- [ ] **Step 4: Run focused tests and typecheck green.** Run `npm test -- tests/review-store.test.ts` and `npm run typecheck`. Expected: migration, continuation and legacy tests pass; optional additions do not break old hosts.
- [ ] **Step 5: Commit only this task's changes.** Commit message: `feat: track review progress by layer and preserve stash revisions`. Record the tested result and any deviations in the ledger.

## Task 2: Immutable stash retention, file fingerprints and shared reads

**Files:** Modify `src/git.ts`, `src/main.ts`, `src/read-cache.ts` where needed, `tests/git.test.ts`, `tests/read-cache.test.ts`. Preserve the existing parallel old/new-content readers and shared-read tests if the concurrent performance work is present.

**Consumes:** Task 1 DiffFile fields; existing repository locks and ReadCache.

**Produces:** `GitService.retainStash(repository: Repository, stash: Stash): Promise<void>`; `GitService.listRetainedStashes(repository: Repository): Promise<Stash[]>`; getDiff files carry exact layer/file fingerprints. ReadCache retains its existing `read<T>(key, provider, weight?): Promise<T>` and `clear(): void` contract.

- [ ] **Step 1: Add real-Git and cache tests.** Reuse the temporary-repository helper in tests/git.test.ts.

```ts
it('keeps an opened snapshot after an external stash drop', async () => {
  const path = await repository();
  const repo = await service.resolveRepository(path);
  await writeFile(join(path, 'example.ts'), 'retained work\n', 'utf8');
  await service.createStash(repo, 'Retain me', false);
  const [stash] = await service.listStashes(repo);
  await service.retainStash(repo, stash);
  git(path, 'stash', 'drop', 'stash@{0}');
  expect((await service.listRetainedStashes(repo)).map(s => s.hash)).toContain(stash.hash);
  expect((await service.getDiff(repo, stash, 'all', 5))[0].fingerprint).toBeTruthy();
  await service.restoreDroppedStash(repo, stash);
  expect((await service.listStashes(repo))[0].hash).toBe(stash.hash);
});
```

The `repository`, `service` and `git` names above are the existing fixtures in tests/git.test.ts. Add cases for a legacy backup-only reference; linked worktrees; SHA-256 objects; duplicate hash reflog entries; equal blobs across rewritten stashes with different context amounts; changed index-only blobs; binary mode changes and renamed paths.

Keep the six-reader cache test and add an entry-limit test at 32 retained values. Count underlying operations for simultaneous same-hash/layer/context reads. Assert retries after failure and that clear prevents stale in-flight values from repopulating the cache.

- [ ] **Step 2: Run red.** Run `npm test -- tests/git.test.ts tests/read-cache.test.ts`. Expected: retention APIs/fingerprints are missing; provided cache tests already passing are retained as regression coverage.

- [ ] **Step 3: Implement Git facts and bounded caching.** retainStash first validates the full hash and two-parent stash shape under the repository lock, then uses `git update-ref refs/stash-review/reviews/<hash> <hash>`. listRetainedStashes reads both reference namespaces using one `for-each-ref` with NUL-delimited object hash, subject, committer timestamp and parents, deduplicates hashes and validates descriptors. restoreDroppedStash accepts a matching backup or review reference and does not create duplicate live entries.

Read name/status and before/after blob/mode metadata with a NUL-delimited raw diff for each tree pair; parse renames without splitting literal paths on spaces. Preserve the original patch parser's metadata source of truth. Fingerprint the exact tuple `[oldMode, oldBlob, newMode, newBlob, oldPath ?? path, path, untracked]` using its canonical JSON representation. Fingerprints must not include context, view mode or reflog index. The untracked third parent uses the empty tree as its before source.

Reuse ReadCache with `new ReadCache(16 * 1024 * 1024, 32)`. Cache immutable diff/source results by logical repository ID, full hash and their semantic read arguments. Mutable list reads are coalesced only while pending. Freeze shared canonical results before returning them; derive new UI values rather than mutating cached files. Clear appropriate read state after Git-path changes, mutations and explicit refresh. Do not bypass the existing lock for Git mutations.

- [ ] **Step 4: Run green.** Run `npm test -- tests/git.test.ts tests/read-cache.test.ts` and `npm run typecheck`. Expected: new retention/fingerprint/cache cases and all original safety cases pass.
- [ ] **Step 5: Commit only this task's changes.** Commit message: `feat: retain reviewed stash objects and fingerprint saved files`. Record source identity and Git command counts in the ledger.

## Task 3: Catalog, compressed snapshots, relocation and portable packages

**Files:** Create `src/review-library.ts`, `src/review-portability.ts`, `tests/review-library.test.ts`, `tests/review-portability.test.ts`; modify `src/main.ts` and `src/types.ts` for adapter contracts.

**Consumes:** Task 1 catalog types, metadata validation and continuation; Task 2 retention and fingerprinted diffs.

**Produces:**

```ts
export interface SnapshotStorage {
  read(repositoryId: string, hash: string, layer: DiffLayer): Promise<SavedLayer | undefined>;
  write(repositoryId: string, hash: string, layer: DiffLayer, snapshot: SavedLayer): Promise<void>;
}
export interface LibraryAdapter {
  getData(): PluginData;
  transaction(change: (draft: PluginData) => void): Promise<void>;
  storage: SnapshotStorage;
}
export interface PortableReview {
  format: 'stash-review'; version: 1;
  repository: {id: string; name: string}; stash: Stash;
  metadata: StashMetadata; layers: Record<DiffLayer, SavedLayer>;
}
export function parsePortableReview(source: string): PortableReview;
export function serializePortableReview(review: PortableReview): string;
export interface ReviewLibraryApi {
  registerRepository(repository: Repository): Promise<Repository>;
  relocateRepository(repositoryId: string, path: string): Promise<Repository>;
  listArchivedReviews(repository: Repository): Promise<Stash[]>;
  archiveReview(repository: Repository, stash: Stash, archived: boolean): Promise<void>;
  getDiff(repository: Repository, stash: Stash, layer: DiffLayer, context: number): Promise<DiffFile[]>;
  getFileContents(repository: Repository, stash: Stash, file: DiffFile, layer: DiffLayer): Promise<{oldContent: string; newContent: string; truncated?: boolean}>;
  continueReview(repository: Repository, stash: Stash, predecessorHash: string): Promise<void>;
  exportReviewData(repository: Repository, stash: Stash): Promise<string>;
  importReviewData(source: string, repositoryId?: string): Promise<ReviewTarget>;
}
// ReviewLibrary implements ReviewLibraryApi; constructor(adapter: LibraryAdapter, git: GitService).
```

Optional ReviewHost capabilities use these same operation names/signatures; exportReviewData returns the JSON source string and importReviewData returns a ReviewTarget. Add `Repository.offline?: boolean`. A UI that receives an old host without these capabilities remains functional.

- [ ] **Step 1: Write transactional and portable tests.** Use an in-memory storage adapter with a Map keyed by the JSON tuple `[repositoryId, hash, layer]`; count reads/writes and inject rejected writes. Tests must cover archive/reload/recovery, manual archival of a still-live stash, legacy descriptors with missing objects, offline snapshots, monotonic snapshot context enrichment, deduplicated writes, linked-worktree relocation, invalid relocation, portable round trips, identical duplicate imports, conflicting imports, size limits and corrupt paths/line ranges.

```ts
it('keeps a stable identity after relocation', async () => {
  const oldId = originalRepository.id;
  const relocated = await library.relocateRepository(oldId, movedRepositoryPath);
  expect(relocated.id).toBe(oldId);
  expect(adapter.getData().reviews[oldId][stash.hash].title).toBe('Keep this review');
});
it('rejects a conflicting import without altering local notes', async () => {
  const before = structuredClone(adapter.getData());
  const conflict = {...portable, metadata: {...portable.metadata, title: 'Different local meaning'}};
  await expect(library.importReviewData(serializePortableReview(conflict), repository.id)).rejects.toThrow(/conflict/i);
  expect(adapter.getData()).toEqual(before);
});
```

Add a controlled slow-persistence test: start import, edit an unrelated existing annotation through the synchronous metadata host, release persistence, and assert both the imported review and the independent edit survive reload. Repeat with rejected persistence and assert the preexisting edit survives while imported entries remain absent. Add tests for `../../` paths, NUL characters, mismatched hunk counts and inconsistent excerpts, SHA-256 hashes, literal angle brackets, case-distinct filenames and a package above 32 MiB.

- [ ] **Step 2: Run red.** Run `npm test -- tests/review-library.test.ts tests/review-portability.test.ts`. Expected: new module imports/APIs are unavailable.

- [ ] **Step 3: Implement catalog and storage transactions.** Library catalog operations construct and validate a draft inside a serialized transaction. Persist the proposal before exposing imported entries. Record synchronous metadata updates that occur during the write, merge/replay those updates into the committed draft, and persist the resulting latest state through the existing save queue. A failed transaction leaves existing catalog entries and independent metadata edits intact.

Use node fs/promises and zlib for native snapshots in the protected plugin directory. Hash/encode repository IDs for directory names; use validated full stash hashes and fixed layer names for files. Write to a unique temporary sibling and rename only within that directory. Decompress with a maximum output size of 32 MiB, validate the snapshot before use, and distinguish absence/corruption from lost notes. Coalesce pending writes by snapshot key and retain the richer saved context without rewriting it on annotation saves.

registerRepository binds its initial legacy ID to canonical paths; linked worktrees share a logical ID. relocation resolves/validates the target before transactionally replacing its local binding, maintaining existing link IDs. Offline catalog entries remain available to listRepositories but cannot invoke Git mutations.

getDiff establishes the durable Git reference, captures the requested canonical layer and its fingerprints, and returns saved data when Git is unavailable. Do not capture every layer during listing. getFileContents persists captured source enrichment only when requested; an offline package without full source reports that it was not included, rather than assembling a fabricated file from patch fragments.

parsePortableReview checks the 32 MiB UTF-8 size before parsing, then validates every repository/stash descriptor, layer snapshot, fingerprint tuple, collection size, line coordinate, hunk count and excerpt. Reject invalid entries instead of silently dropping parts of a portable review. serializePortableReview writes only portable descriptors and metadata, never local settings or executable paths. Export acquires all three layers on demand, plus excerpts for annotations. Import produces an offline library entry unless a local target is explicitly selected; identical entries deduplicate and differing local metadata causes a descriptive conflict error. No import path invokes create/apply/drop/store.

- [ ] **Step 4: Run green.** Run `npm test -- tests/review-library.test.ts tests/review-portability.test.ts tests/review-store.test.ts` and `npm run typecheck`. Expected: transactional tests preserve unrelated edits and all round trips are deterministic.
- [ ] **Step 5: Commit only this task's changes.** Commit message: `feat: archive and move portable stash reviews`.

## Task 4: Indexed search, whitespace presentation and Markdown bodies

**Files:** Create `src/ui/change-search.ts`, `src/ui/ChangeSearch.tsx`, `src/ui/MarkdownText.tsx`, `tests/change-search.test.ts`; modify `src/ui/AnnotationThread.tsx`, `src/ui/DiffView.tsx`, `src/review-store.ts`, `styles.css`, and `tests/review-store.test.ts`. Reuse DeferredBlock rather than adding a second deferred-rendering system.

**Consumes:** Canonical fingerprinted DiffFile values and metadata; SavedLayer snapshots; optional `ReviewHost.renderMarkdown(source: string, element: HTMLElement): () => void`.

**Produces:**

```ts
export interface ChangeMatch {path: string; side: DiffSide; line: number; start: number; end: number}
export interface ChangeIndex {rows: Array<{path: string; side: DiffSide; line: number; text: string; lower: string}>}
export function indexChanges(files: readonly DiffFile[]): ChangeIndex;
export function findChanges(index: ChangeIndex, query: string): ChangeMatch[];
export function whitespacePresentation(lines: readonly DiffLine[]): DiffLine[];
export function annotationSearchText(annotation: Annotation): string;
export function codeFence(source: string, language?: string): string;
```

MarkdownText accepts source plus the optional renderer and uses its returned cleanup from useEffect. ChangeSearch accepts query, match count, current match index and navigation callbacks; the owning ReviewApp controls a 100 ms debounce. DiffView gains optional presentation/search props and original-coordinate reveal targets. Existing props remain compatible.

- [ ] **Step 1: Add search, noise and export tests.**

```ts
it('searches literal diff text with original coordinates', () => {
  const file: DiffFile = {path: 'src/é.ts', status: 'modified', additions: 1, deletions: 1,
    binary: false, untracked: false, hunks: [{header: '@@ -7 +7 @@', oldStart: 7,
      oldCount: 1, newStart: 7, newCount: 1, lines: [
        {type: 'delete', oldLine: 7, text: 'const old = ".*";'},
        {type: 'add', newLine: 7, text: 'const next = ".*";'}]}]};
  expect(findChanges(indexChanges([file]), '.*').map(m => [m.side, m.line])).toEqual([['old', 7], ['new', 7]]);
});
it('hides whitespace-only groups without moving original lines', () => {
  const rows: DiffLine[] = [{type: 'delete', oldLine: 2, text: 'a = 1;'},
    {type: 'add', newLine: 2, text: 'a  =  1;'}, {type: 'add', newLine: 3, text: 'realChange();'}];
  const original = structuredClone(rows);
  const result = whitespacePresentation(rows);
  expect(result.find(l => l.text === 'realChange();')?.newLine).toBe(3);
  expect(rows).toEqual(original);
});
```

Add complete whitespace-only replacement, blank-line/CRLF, mixed meaningful replacement and unequal-row-count cases. Meaningful added text in a mixed replacement must remain visible. Add Unicode case matching, empty queries, repeated matches on one line, HTML-like text and searches over replies. Test codeFence with source containing triple/four backticks and tilde runs; Markdown export must contain the unchanged code and original line range. Missing excerpts retain the annotation with an explanation.

- [ ] **Step 2: Run red.** Run `npm test -- tests/change-search.test.ts tests/review-store.test.ts`. Expected: missing search/fence exports and richer export assertions fail.

- [ ] **Step 3: Implement canonical-coordinate presentation.** Build the index once for a files identity, excluding info rows and selecting Old for deletion and New for context/addition. Store lowercase search text once. Literal indexOf searches return all occurrences and retain original file/side/line/column values. Reset active match when the index/query changes; render at most 200 match markers at a time while allowing next/previous navigation through all results.

Derive whitespace presentation after canonical full-context sections are assembled. Compare whitespace-normalized deletion/addition groups, hiding only equivalent changes and preserving meaningful mixed changes. Keep the canonical hunks, blob fingerprints, source contents and progress untouched. Original comments or search matches hidden by the presentation cause unfiltered reveal. Highlight only escaped source text nodes inside existing syntax markup; do not interpolate the query into HTML or an unescaped regular expression.

MarkdownText mounts its renderer only while visible/expanded, cancels stale renders via the component lifecycle, and cleans up on unmount/source change. Add native Markdown rendering later in Task 5; the shared component falls back to safe text without a renderer. AnnotationThread uses MarkdownText for body/replies and preserves edit controls. codeFence selects a delimiter longer than any run in the excerpt. Export per-layer progress and excerpts, including predecessor provenance.

- [ ] **Step 4: Run green.** Run `npm test -- tests/change-search.test.ts tests/review-store.test.ts tests/word-diff.test.ts tests/ui-format.test.ts` and `npm run typecheck`. Expected: syntax/copy text remains intact and all derived presentations are immutable.
- [ ] **Step 5: Commit only this task's changes.** Commit message: `feat: search saved changes and render richer review notes`.

## Task 5: Compact native workspace, preview and integration tests

**Files:** Modify `src/main.ts`, `src/ui/ReviewApp.tsx`, `src/ui/FileTree.tsx`, `src/ui/DiffView.tsx`, `src/ui/AnnotationThread.tsx`, `src/markdown.ts`, `preview/demo-host.ts`, `preview/fixtures.ts`, `styles.css`, `tests/package-smoke.mjs`, `tests/markdown.test.ts`, `tests/e2e/review.spec.ts`, `tests/e2e/integration.spec.ts`; create `src/ui/ReviewLibraryControls.tsx` and `tests/e2e/durable-reviews.spec.ts`. Preserve supplied DeferredBlock/performance behavior.

**Consumes:** All earlier task interfaces. No alternate catalog or duplicate Git layer is introduced.

**Produces:** Complete user workflows through native and browser hosts, optional capabilities on ReviewHost, stable archived protocol targets, and documented native renderer cleanup.

- [ ] **Step 1: Write browser and compiled-host regression cases before wiring controls.**

```ts
test('a dropped review remains readable and recoverable after reload', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'More stash actions'}).click();
  await page.getByRole('button', {name: 'Drop stash', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Drop stash', exact: true}).click();
  await page.reload();
  await page.getByRole('button', {name: 'Archived reviews', exact: true}).click();
  await expect(page.locator('.sr-code').first()).toBeVisible();
  await page.getByRole('button', {name: 'Restore stash', exact: true}).click();
  await page.getByRole('button', {name: 'Active stashes', exact: true}).click();
  await expect(page.locator('.sr-stash-card')).toHaveCount(6);
});
```

Add `staged viewed flags do not hide unstaged work`, `revised stash retains original comments and copies only exact matches`, `portable import opens an offline archive`, `archive list loads only the selected snapshot`, `content search reveals a distant deferred row`, `whitespace filtering does not orphan comments`, `Markdown wiki links and fences render and clean up`, and `two embeds keep independent edits during import`. Use controlled host overrides like the existing integration/performance tests, not extra product-only hooks.

Extend package-smoke with Component/MarkdownRenderer API mocks and assert renderer children unload; stable links after relocation; no Git mutation during portable import; persistence errors leave existing notes intact; six identical readers still share one operation. Extend markdown tests so a copied hash can resolve to an archive while invalid targets never open another stash.

- [ ] **Step 2: Run red.** Run `npm run build`, `npm run test:package`, and `npm run test:e2e -- tests/e2e/durable-reviews.spec.ts --workers=2`. Expected: baseline build still passes; new controls and host capabilities fail their assertions before wiring.

- [ ] **Step 3: Wire the native host and compact UI.** Initialize catalog/storage onload and pass the existing save queue into the library transaction adapter. listRepositories returns resolved stable bindings plus offline library entries. getDiff/getFileContents use the library and shared immutable cache. Native renderMarkdown creates an Obsidian Component child, calls MarkdownRenderer.render, and returns an idempotent remove/unload cleanup; rendering failure falls back to safe text.

ReviewLibraryControls supplies Active stashes / Archived reviews, Archive review / Restore to Active, Restore stash, Continue from previous review, Export review data / Import review data in existing menus/dialogs. Native import uses a file input or text dialog and validates before commit. Export uses a Blob/download for portable JSON; Markdown export still creates a vault note. Settings add relocation for an existing logical binding. Show missing/limited saved context explicitly and disable apply/drop/create where offline data cannot support them.

ReviewApp uses reviewedPaths for its selected layer, a memoized membership set and layer-specific folder/progress counts. Layer changes restore their collapse state without resetting comments. Archive pages contain 50 entries; search filters summaries before pagination. Store metadata/canonical snapshots outside the archive-list render path. A protocol target can select its exact archived hash even when Active is selected initially.

ChangeSearch appears in the diff toolbar with a scope label, count and previous/next controls. Annotation search lives beside Open / Resolved. Original-coordinate navigation expands the target file, restores unfiltered code when needed and forces its deferred row chunk. Preserve canonical copy across unloaded rows and source-copy behavior. Reuse the supplied shared IntersectionObserver and mount chunks of 200 rows for large diffs. Keep ordinary small diffs and their keyboard/selection behavior intact.

DemoHost implements the same persistent catalog, archive/revision and portable contracts in localStorage, with realistic retained snapshots and an offline repository. Its Markdown adapter creates text/links safely and demonstrates lists/fences/wiki links without adding a runtime package. Snapshot/canonical data is not reserialized on every keystroke. Existing hosts without new optional capabilities keep the original UI.

- [ ] **Step 4: Run integration green.** Run `npm run build`, `npm test`, `npm run test:package`, and `npm run test:e2e -- --workers=2`. Expected: all existing tests plus the new durable/performance cases pass. Inspect desktop, laptop and embed screenshots for compact controls, rendered Markdown and visible error states.
- [ ] **Step 5: Commit only this task's changes.** Commit message: `feat: integrate archived and portable reviews into Obsidian`.

## Task 6: Performance evidence, documentation and final review

**Files:** Create `scripts/benchmark-durable-reviews.mjs`; modify `README.md`; save this plan's benchmark reports under unique names in `benchmarks/results/`. Do not overwrite existing baseline reports or modify benchmark source owned by the concurrent task.

**Consumes:** Completed production host/UI, existing benchmark fixtures and Task 5 workflows.

**Produces:** Reproducible before/after measurements and accurate user documentation.

- [ ] **Step 1: Verify the pre-change baseline recorded before Task 1.** Confirm its source SHA, raw samples, viewport and CPU settings match the execution ledger, rather than recording modified source as a baseline. The earlier `review-expansion-baseline-20261012-compute.json` is supplementary evidence, since concurrent source changes may have changed the actual starting point.

- [ ] **Step 2: Add focused measurements and assertions.** The new script uses esbuild's write:false production bundle and Playwright through existing dependencies. Measure index build and literal search over 1,000 and 5,000 files; 50-entry archive page opening without other snapshot reads; layer-switch progress lookup; whitespace toggles without Git calls; portable validation/round trip up to the package limit; exact-fingerprint continuation; six simultaneous identical reads; Markdown mount/unmount and post-GC retained memory.

```js
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return {medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], rawMs: values};
};
const compare = (baseline, current) => ({
  baseline, current,
  investigate: current > baseline + Math.max(20, baseline * 0.20)
});
```

Collect at least five samples; report bundle size, Git command counts, long tasks and memory as well as timings. Assert one underlying operation for six duplicate reads and no additional Git operation from search/noise toggles. Performance targets are those in the spec, not automatic claims of universal speed. Investigate relevant regressions above the comparison threshold and retain raw samples.

- [ ] **Step 3: Run post-change measurements and fix measured regressions.** Run `node --expose-gc scripts/benchmark-durable-reviews.mjs --samples 5` and the existing `npm run benchmark` section commands using unique after-report paths. Compare the same fixtures, viewport/CPU settings and code identities. Diagnose a failed assertion or material regression by its relevant source file before changing it. Write a reproducing test before a behavioral performance fix; preserve exact annotation/copy semantics while reducing unnecessary work.

- [ ] **Step 4: Update README with actual tested behavior.** Document archive/recovery after restart, per-layer legacy migration, explicit predecessor selection, relocation, portable offline limitations/limits, Markdown excerpts, diff-text search, whitespace presentation, snapshot storage/retention and measured large-diff behavior. State native GUI limitations accurately rather than extrapolating from browser tests.

- [ ] **Step 5: Verify everything and obtain one final independent review.** Run `npm run build`, `npm test`, `npm run test:package`, `npm run test:e2e -- --workers=2`, and focused benchmarks after the final source change. Run git diff --check and repeat the project-wide search to ensure no runtime selected-layer view still reads global reviewedFiles directly; compatibility fields and old-fixture inputs intentionally remain. Review the whole branch against the approved spec, this plan and all five Review Focus cases with one fresh reviewer under the executing-plans skill. Resolve important findings in one tested fix pass, record decisions in the ledger, and do not publish.

- [ ] **Step 6: Commit verified documentation and benchmark additions.** Commit message: `docs: document durable reviews and measured performance`. Report implemented features, test counts, before/after measurements and any material remaining limitations with links to the actual artifacts.

## Plan self-review

All five requested feature groups map to Tasks 1–5; performance and revision safety apply across the sequence and are verified in Task 6. All interface names consumed by later tasks are produced above. Portable snapshots use SavedLayer consistently, preserving the context amount. The unchanged `reviewedFiles` alias is intentional compatibility, not a missed rename. Each Review Focus case has an explicit owner and regression test. No release, dependency installation or destructive cleanup is required by this plan.

**Execution recommendation:** Inline implementation in an isolated worktree, followed by one independent whole-branch review. The tasks share one catalog and identity model, so one implementer avoids repeated context loading; isolation protects the concurrent performance work in the current checkout. User review of this written plan and selection of execution/workspace are required before product-source edits.
