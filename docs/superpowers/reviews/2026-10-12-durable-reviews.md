# Durable reviews: final review and verification

Approved scope: archived reviews and recovery browsing, progress per diff layer, relocation and portable reviews, Obsidian Markdown and exports, change search, whitespace noise controls, and safe explicit continuation after stash replacement. The design and six-task implementation plan are in the adjacent specs and plans directories.

Implementation branch: codex/durable-reviews. Source verified at 81f6ebd. Completed performance work at 5e438d8 is integrated through merge 76e72ff; the original checkout and its performance reports were preserved. No release, version bump, publication, or remote push was performed.

## Independent review

One fresh reviewer examined the whole branch against the approved design, plan, review-focus cases, and execution decisions. It found four Important issues, no Critical issues, and no Minor issues. All four were accepted and corrected in one tested pass; no second reviewer was dispatched.

| Finding | Result and reproducing verification |
| --- | --- |
| Relocation lost physical common-directory identity when another linked worktree was registered | Persist gitId separately from the logical review ID; resolve concurrent registrations inside the shared transaction. The relocated-worktree/reload/conflicting-common-directory test failed before the fix and passes after it. |
| Failed portable import left snapshots that a different retry could reuse with unrelated notes | Serialize operations for the same review, reject contradictory existing captures, and remove only newly written snapshots on failure. Failed-import/retry and conflicting-code tests failed before the fix and pass after it. A concurrent reader test verifies it cannot see an uncommitted import. |
| Portable annotations accepted fabricated excerpts or ranges beyond known source | Validate ranges and original excerpt text against captured full source or fully observed hunk lines. Contradictory-excerpt tests failed before the fix and pass after it; unavailable legacy source remains explicitly allowed. |
| Embedded Markdown lost its containing note's source path | Carry context.sourcePath through the host and rendered descriptions, notes, and replies. The compiled-host assertion failed before the fix and passes after it; browser tests verify rerender/disposal when the path changes. |

The reviewer declined to judge unfinished final performance measurements and native GUI interactions with third-party themes/renderers. Final measurements are now complete; native GUI interactions remain a stated manual-verification limit.

## Final verification

- npm run build: passed, including TypeScript checks.
- npm run test:package: passed; compiled native host, gzip snapshot storage and removal, import rollback, offline legacy reviews, Markdown context and lifecycle.
- npm test: 115/115 tests passed across 11 files.
- Isolated Playwright run on port 4183: 49/49 browser tests passed with two workers.
- Final focused audit: all 27 timed cases meet their targets; both UI cases record zero long tasks and no browser runtime errors.
- Final comparisons against 5e438d8: 39 compute, 18 Git/native-host, and 118 browser cases. No p95 exceeds the investigation threshold; every Git and browser case meets its recorded target. Warm plain-code formatting of 900,000 characters remains slightly over its 5 ms compute target in both versions.
- Final desktop, laptop, and embed screenshots checked. Project searches retain reviewedFiles only for compatibility, fixtures, and the tree's selected-layer input; runtime review progress uses the layer helpers. All snapshot-storage adapters implement rollback removal, all native Markdown paths carry context, and conflict-marker searches are empty.

Raw measurements, source identities, timing caveats, bundle sizes, Git counts, and memory checks are linked from [the performance report](../../../benchmarks/durable-reviews-performance.md).

## Rulings made during execution

These are the complete decisions recorded by the inline executor, in order. They resolve implementation or verification choices; all Important review findings were fixed.

1. Use native PowerShell equivalents for Unix ledger helpers because this environment is Windows. Cost if wrong: ledger formatting only.
2. Copy the supplied dirty performance work as an identified baseline into the isolated checkout, preserving the original task's files. Cost if wrong: an incomplete concurrent snapshot, exposed by baseline tests.
3. Put the shared save/transaction queue in DataTransactions in review-library.ts and reuse it in native and preview adapters so the tests exercise actual merge and rollback behavior. Cost if wrong: all persistence paths; concurrent-write and deletion regressions cover them.
4. Add optional lightweight ReviewSummary and Stash.inStashList host contracts to avoid copying archived discussions and to distinguish restoring a review from recovering a dropped Git stash. Cost if wrong: old-host compatibility; the metadata fallback and existing tests cover it.
5. Add five-sample comparison mode in the new benchmark script while preserving the supplied runner's source. Cost if wrong: measurement validity; source hashes and raw samples remain available.
6. Keep mandatory first-read Git retention despite the initial cold-cache p95 overhead because it preserves original stash objects after removal. Cost if wrong: first-time read responsiveness; the final report states that cost and cached timings separately.
7. Complete the performance judgment after the reviewer set aside unfinished measurements, comparing final source with the completed performance commit 5e438d8. Cost if wrong: synthetic and physical host behavior can differ; the report retains samples and explicit host limits.
8. Accept compiled-host and production-browser evidence for Markdown context/lifecycle while documenting actual Obsidian GUI and third-party renderer/theme interactions as unverified. Cost if wrong: host-specific rendering interactions may still need manual checking.

Deferred minors: none.
