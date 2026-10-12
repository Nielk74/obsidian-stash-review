# Durable, portable stash reviews

## Intent and approved scope

The user approved a compact extension of the existing Stash Review workspace on 2026-10-12. Implement archived reviews and recovery, progress per diff layer, repository relocation and portable reviews, richer Obsidian Markdown integration, search within changes and annotations, and an Ignore whitespace control. The user also requires the result to be optimized and fast, and existing reviews to survive replacement of stash contents.

Keep the current workspace and menus. An Active / Archived switch, small search controls, and actions in existing menus are sufficient. No branch/worktree management, selective restore, review approval workflow, or new runtime dependencies are part of this change.

This written specification is the next review artifact after the approved conversational design. Implementation begins after written-spec and implementation-plan review as required by the project skills.

## Identity, migration, and changed stashes

A review belongs to a logical repository ID and an immutable full stash commit hash. Never use stash reflog positions, branch names, stash titles, repository display names, or directory basenames as identity.

Add a versioned repository catalog that binds a logical ID to local paths. Initially retain existing repository IDs so existing reviews and protocol links remain valid. Explicit relocation validates the new Git repository before changing the binding, preserves the logical ID, and continues to share identity across linked worktrees. Do not identify unrelated repositories by their remote URL alone. Failed relocation leaves the old binding and metadata intact.

Migrate saved data to schema version 2 without discarding existing titles, descriptions, tags, pins, annotations, replies, or progress. Existing path-only viewed flags belong to the All layer; they must not imply review of the Staged or Unstaged layers. Keep the existing `reviewedFiles` field as a compatibility representation of All progress so old fixtures and the user's benchmark host keep working. New layer-aware operations use centralized helpers and synchronize the All compatibility representation.

A rewritten stash has a different hash and starts as a separate review. Preserve the old review in the archive. Never infer a successor from its reflog index or message. The new stash offers Continue from previous review, with the predecessor chosen explicitly. Carry title, description, tags, pins, comments, and progress only where appropriate: unchanged files carry their layer-specific progress and comments when their exact before/after Git blobs and modes match in that layer. Compare case-sensitive paths, including rename source paths. Changed-file comments remain on the original snapshot, with a link to that review; do not attach old line numbers to new code. Record the predecessor relationship so original context remains discoverable.

Preserve legacy comments without verifiable fingerprints on the original revision. A progress fingerprint is independent of context-line settings, diff layout, search, and whitespace presentation. Binary files use blob identity and modes rather than decoded text. Handle SHA-1 and SHA-256 repositories.

## Archive and recovery

Add an Active / Archived switch to the existing stash list. Archive review is a metadata action and keeps any live Git stash. A reviewed stash that disappears from the live list also becomes available in Archived. Restore to Active reverses manual archival; Restore stash is offered when the actual stash is absent and its retained Git object is available.

Retain a reviewed stash under `refs/stash-review/reviews/<full-hash>` when it is first opened, before it can disappear from the Git stash list. Existing drop backups under `refs/stash-review/backups/` remain supported. Discover legacy backup references in a batched operation, including backups that have no new catalog record. Never remove review or backup references automatically.

Store a small stash descriptor and archive status in the catalog. Persist captured canonical diff layers separately from settings and annotations, in compressed snapshot files beneath the protected plugin folder. Read an archived snapshot only when selected. Opening a review captures its requested layer; other layers can be read from retained Git objects when needed. Snapshot writes are deduplicated and serialized, and never rewrite immutable content on every annotation save.

Recovery after reload must work without transient Undo state. Prefer retained Git objects for local review; use saved snapshots if the repository or object is unavailable. Clearly distinguish missing legacy code from missing notes. Imported archives without Git objects remain readable and exportable, with Git mutation controls disabled. A linked archived hash opens that exact review rather than selecting another stash.

## Progress per layer

All, Staged, and Unstaged each have their own viewed-file set. Their checkboxes, folder counts, collapse-on-viewed behavior, summary counts, and Hide viewed files filter use the selected layer. Changing layers restores that layer's state. Embeds and tabs share updates without overwriting independent edits.

Revision continuation preserves progress only for exact matching layer/file fingerprints. Presentation controls never mark files viewed or reset progress. Use sets for membership checks and memoized aggregates rather than repeated linear scans.

## Portable reviews and relocation

Add Relocate repository in settings and Export review data / Import review data in the existing workspace menu. Continue offering Markdown export separately.

A versioned portable JSON package contains the logical repository descriptor, stash descriptor, metadata, predecessor information, layer/file fingerprints, all three canonical diff layers, and annotated code excerpts. Source paths and Git executable settings are not imported as local configuration. Portable packages contain enough saved code to review offline; full-file context is included only where already captured or needed for an annotated excerpt. Binary content remains represented by its metadata. Missing or size-limited context is explicitly represented, never fabricated.

Export reads uncaptured layers only on explicit export. Import validates the entire package before changing anything, including hashes, relative paths, line/range consistency, layer values, fingerprints, collection limits, and serialized size. The uncompressed limit is 32 MiB per package. Preserve literal filenames and safely handle Unicode and code containing HTML or Markdown delimiters.

Import can attach to an explicitly selected local repository, or create a local archived-review library entry with no Git binding. Deduplicate identical entries. Refuse conflicting metadata for an existing repository/hash instead of overwriting notes or timestamps silently. Build and validate the proposed import before committing persistence; a failed write keeps existing reviews usable and reports the failure. Import never executes Git mutations or embedded content.

## Markdown and exported notes

Render descriptions, annotation bodies, and replies through Obsidian's native `MarkdownRenderer`, with working wiki links, Markdown links, lists, and fenced code. Give the rendering component an explicit lifecycle and unload it when its view, thread, or embed unmounts. Use a browser-preview adapter so shared React UI remains usable outside Obsidian. Render only visible, expanded content, and rerender a body only when that body or its source path changes.

Markdown export includes repository/stash provenance, per-layer progress, annotations and replies, and original annotated code excerpts with their line ranges. Use safe fences for code that itself contains backticks or tildes. Preserve notes even when the original excerpt cannot be recovered; state that limitation beside the annotation. Archive links remain navigable.

## Search and whitespace presentation

Add a literal, case-insensitive Find in changes field with a match count and previous/next navigation. Search the captured diff text for the selected layer; do not spawn Git processes or load every full file on each keystroke. State its diff-text scope clearly. Search is debounced by 100 ms and reuses a per-snapshot index. Bound rendered matches to 200 at a time, with navigation continuing through the remaining indexed results. Selecting a result reveals its file and original line without changing progress.

Add literal search over annotation bodies, replies, and paths alongside the existing Open / Resolved filter. Debounce and index by metadata revision. Do not run arbitrary regular expressions from user input.

Ignore whitespace hides whitespace-only change groups in a derived presentation of the canonical diff. Preserve original line coordinates, blobs, counts used for canonical progress, and stored anchors. Search and noise toggles reuse cached canonical data and need no new Git commands. Opening a hidden annotation reveals its original code by temporarily restoring the unfiltered presentation. Keep files with rename, binary, mode, or other meaningful metadata changes discoverable.

## Performance requirements

Use Node.js 22, TypeScript, React 19, and Obsidian desktop 1.6 or later. Add no runtime dependencies. Preserve the existing benchmark sources, package changes, and reports already present in the working tree.

Deduplicate in-flight immutable reads across tabs and embeds, keyed by logical repository, full hash, layer, context, and case-sensitive path as appropriate. Failed requests are evicted and retryable. Mutable repository/stash-list reads have short-lived shared requests and explicit invalidation after mutations or refresh. Existing Git mutation serialization across worktrees remains in force.

Bound the new immutable-read cache to 16 MiB and 32 entries. Coalesce snapshot writes. Existing syntax caches remain bounded. Search indexes are reused while their canonical snapshot is unchanged, and archive lists render in pages of 50 entries without loading snapshot contents or rendering Markdown for every archived item.

Large diffs render progressively in chunks of 200 rows rather than eagerly mounting thousands of code rows. Navigation to an annotation or search result reveals the required chunk directly. Copying full source and portable export operate on canonical data, independently of how many rows are mounted. Ordinary small diffs retain the existing interaction model.

Collect reproducible before/after metrics using the existing benchmark fixtures on the same host, at least five samples for comparison, and production React builds. Measure median and p95 response times, Git command counts, cache reuse, long tasks, bundle size, and post-unmount retained memory. Add focused workloads for archive browsing, layer switches, search typing, whitespace toggles, relocation, portable round trips, and revision continuation.

Targets: typical initial paint at or below 500 ms p95; typical interactive actions at or below 100 ms p95 excluding the deliberate 100 ms search debounce; compute-only search/filter operations at or below 30 ms p95 for 1,000 files; six concurrent identical immutable reads issue one underlying operation. Compare changed existing actions with their fresh baseline and investigate regressions above 20 percent or 20 ms, whichever is larger. Existing above-target heavy workloads must be reported accurately; no claim that every runtime or repository is uniformly fast.

## Change manifest

The project-wide search covered all references to review identity, `reviewedFiles`, `StashMetadata`, `ReviewHost`, `PluginData`, `getDiff`, and backup restoration, including the user's benchmark adapters. This is an additive migration, not a bulk rename. Planned source and test changes are:

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Versioned catalog, per-layer progress, archive and portable contracts, optional host capabilities. |
| `src/review-store.ts` | Validation/migration, layer progress helpers, explicit revision continuation, Markdown export data. |
| `src/review-library.ts` (new) | Catalog, archived-review snapshot persistence, atomic import/relocation orchestration. |
| `src/review-portability.ts` (new) | Portable package validation, serialization, non-destructive merge proposals. |
| `src/read-cache.ts` (new) | Bounded cache and in-flight read coalescing. |
| `src/git.ts` | Retention references, batched backup discovery, blob fingerprints and shared immutable reads. |
| `src/main.ts` | Obsidian adapters, catalog persistence, local repository mapping and relocation settings. |
| `src/markdown.ts` | Exact archived targets and stable logical repository links. |
| `src/ui/ReviewApp.tsx` | Compact archive controls, selected-layer progress and new menu actions. |
| `src/ui/ReviewLibraryControls.tsx` (new) | Archive/recovery, import/export and explicit predecessor selection controls. |
| `src/ui/MarkdownText.tsx` (new) | Lifecycle-managed lazy Markdown body rendering. |
| `src/ui/change-search.ts` (new) | Reusable literal search indexes and canonical-coordinate whitespace presentation. |
| `src/ui/ChangeSearch.tsx` (new) | Debounced search controls and result navigation. |
| `src/ui/DiffView.tsx` | Match display, noise presentation and progressive large-diff rendering. |
| `src/ui/AnnotationThread.tsx` | Markdown bodies, deferred replies and original-revision links. |
| `src/ui/FileTree.tsx` | Selected-layer progress and content-search result visibility. |
| `styles.css` | Compact controls, Markdown body styling, search matches and progressive rendering notices. |
| `preview/demo-host.ts` | Realistic persistent preview support for all new workflows. |
| `preview/fixtures.ts` | Archived, relocated and revised-review examples. |
| `tests/review-store.test.ts` | Legacy migration, layer isolation, fingerprints and conservative continuation. |
| `tests/git.test.ts` | Real Git retention/recovery, fingerprints, SHA-256 and deduplicated reads. |
| `tests/markdown.test.ts` | Archived links and logical identity preservation. |
| `tests/package-smoke.mjs` | Compiled native host, Markdown lifecycle, relocation, import/export and persistence. |
| `tests/review-library.test.ts` (new) | Persistence, relocation, legacy recovery and missing repositories. |
| `tests/review-portability.test.ts` (new) | Round trips, invalid packages, duplicate/conflicting imports and limits. |
| `tests/read-cache.test.ts` (new) | Concurrent requests, cache eviction, failure retry and invalidation. |
| `tests/change-search.test.ts` (new) | Search coordinates, escaping, Unicode and whitespace filtering. |
| `tests/e2e/review.spec.ts` | Adapt existing layer/progress assertions without losing coverage. |
| `tests/e2e/integration.spec.ts` | Markdown lifecycle and shared tab/embed behavior. |
| `tests/e2e/durable-reviews.spec.ts` (new) | Archive reload/recovery, revised stashes, portable workflows and search. |
| `scripts/benchmark-durable-reviews.mjs` (new) | Focused performance measurements using existing workloads. |
| `README.md` | User-facing workflows, storage, migration, limits and performance behavior. |

Existing benchmark files and `package.json` changes remain owned by the user's current work. New optional host capabilities and migration-compatible metadata avoid requiring changes to those adapters. Any manifest adjustment must be stated before the affected source is edited.

## Verification and failure behavior

Write meaningful failing tests before implementation of persistence and identity changes. Verify preservation of existing metadata through migration and restart, per-layer isolation, multiple simultaneous embeds, external stash replacement, renamed/deleted/binary files, repository movement, missing objects, interrupted writes, invalid imports, repeated retries, and large-file limits.

Run the full existing build, unit tests, compiled-plugin smoke test, and browser suite after integration. Run the before/after performance workloads and inspect production-preview screenshots at desktop, laptop and embed sizes. Preserve all unrelated working-tree changes. Do not bump versions, tag, publish, or create a release as part of this implementation.
