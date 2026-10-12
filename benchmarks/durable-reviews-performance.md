# Durable review performance audit

Measured on Windows 11, AMD Ryzen 7 9800X3D, 16 logical CPUs, 31.1 GiB RAM, Git 2.50.1.windows.1, Node 24.5.0, and Chromium 156.0.8078.4. Node 22 remains the development target; this run does not establish Node 22 runtime results. Browser tests use production React bundles, a synthetic host, a 1440 × 900 viewport, and 1× CPU. Real Git and the compiled native host are measured separately. Benchmarks ran separately from the test suites.

The final baseline is **5e438d8**, the completed performance work before durable-review additions. The final source is **81f6ebd**, including all independent-review fixes and the completed performance integration. Every JSON report retains source/bundle hashes and raw samples. Reports mark the working tree dirty because benchmark artifacts were being written; all measured source files match that commit. The original runner and its reports remain intact.

The comparison contains 39 compute, 18 Git/native-host, and 118 browser measurements. Timed repeated workloads use five samples, including heavy startup and native-reader cases otherwise capped by the supplied runner. Thirteen browser actions and initial native bundle evaluation remain single-sample observations; their reported p95 does not establish a latency distribution. No final p95 comparison exceeds the investigation threshold of baseline plus the greater of 20 ms or 20%. All 118 browser measurements and all 18 Git/native-host measurements meet their recorded targets. One compute case, warm plain-code formatting of 900,000 characters, measures 5.023 / 5.818 ms against a 5 ms target; the baseline is 5.261 / 5.570 ms.

## Existing workloads

| Workload | Before median / p95 (ms) | After median / p95 (ms) |
| --- | ---: | ---: |
| Typical initial paint | 82.0 / 158.8 | 82.3 / 152.8 |
| 1,000-file initial paint | 143.6 / 281.4 | 100.8 / 183.6 |
| Dense 5,000-line initial paint | 99.5 / 185.2 | 99.1 / 161.1 |
| Six-embed initial paint | 115.2 / 173.3 | 99.0 / 159.8 |
| 1,000-file All layer switch | 46.7 / 48.8 | 47.9 / 48.7 |
| Dense 5,000-line Unstaged switch | 30.9 / 31.1 | 29.4 / 30.3 |
| Dense 5,000-line All switch | 30.3 / 31.4 | 29.1 / 31.1 |
| Wrap after visiting every dense diff row | 50.0 / 62.9 | 34.6 / 50.3 |
| Six identical native diff readers, cold cache | 451.016 / 487.989 | 441.992 / 574.713 |
| Repeated native diff read, retained cache | 0.001 / 0.001 | 0.001 / 0.001 |
| Native metadata save, 1,000 reviews | 24.343 / 30.458 | 27.670 / 28.825 |

Typical existing actions stay at or below 34.5 ms p95. The 1,000-file, dense, and six-embed existing actions stay at or below 69.8, 50.3, and 34.6 ms p95 respectively. The browser comparison bundle grows from 488,302 to 503,732 bytes (gzip: 153,168 → 157,698); the compiled native bundle grows from 1,008,987 to 1,053,768 bytes. No runtime dependency was added.

The first native diff sample creates its retention reference and saves a compressed snapshot. Across five cold-cache batches, Git command count is 30 → 32, while six concurrent readers still share one diff operation. Median latency is similar, but the final first-read p95 is higher. Retention is kept because it protects original reviewed objects after external stash removal. Real Git process startup and disk work remain hundreds of milliseconds; browser rendering timings do not describe those costs.

The initial implementation comparison exposed eager search indexing: a regression test counted 40,200 diff-text accesses before a query. Lazy indexing over the canonical snapshot removed that work and preserves reuse during typing and source hydration. An interim comparison also measured fully visited wrap changes above one second. The completed concurrent performance work added committed row-action bindings and row memoization; integration preserves those optimizations and includes search, noise, and Markdown context in memoization inputs. The table measures the final combined result.

Raw final comparisons: [before compute](results/durable-before-final-compute.json), [after compute](results/durable-final-compute.json), [before native/Git](results/durable-before-final-git.json), [after native/Git](results/durable-final-git.json), [before browser](results/durable-before-final-browser.json), [after browser](results/durable-final-browser.json). Earlier reports comparing the initial supplied snapshot at a30ede4 with pre-integration durable source remain under durable-before/after and durable-before/after-five filenames for traceability; they are not the final performance result.

## New workflows

All values below use five samples from final source 81f6ebd. Library-only measurements use in-memory storage; they exclude disk and Git spawn costs.

| Workload | Median / p95 (ms) |
| --- | ---: |
| Build literal-search index, 1,000 files | 0.745 / 1.082 |
| Search indexed text, 1,000 files | 0.252 / 0.403 |
| Build literal-search index, 5,000 files | 4.374 / 5.650 |
| Whitespace presentation, 5,000 files | 6.545 / 6.793 |
| Selected-layer progress lookup, 1,000 files | 0.010 / 0.022 |
| Browse 1,000 archive descriptors | 0.348 / 0.470 |
| Read 1,000 archive summaries | 0.177 / 0.239 |
| Continue an exact matching 1,000-file revision | 89.208 / 90.335 |
| Typical portable export/import | 1.910 / 1.966 |
| Validate a 30,302,002-byte portable package | 40.179 / 44.555 |
| Typical search response including debounce | 131.6 / 133.6 |
| Typical search response excluding 100 ms debounce | 31.6 / 33.6 |
| 1,000-file search excluding debounce | 29.3 / 29.6 |
| Typical whitespace toggle | 31.9 / 32.4 |
| Typical archive page switch | 32.0 / 34.3 |

The [focused report](results/durable-focused.json) asserts that six identical immutable readers issue one underlying diff operation and one snapshot write; archive descriptors read no snapshots; search, whitespace, and archive paging issue no diff reads; and archive pages contain 50 entries. All 27 timed focused cases meet their targets. Both focused UI workloads record zero long tasks, and all browser reports record zero uncaught errors. Search timings include two animation frames and a conservative 110 ms measurement wait; only the deliberate 100 ms debounce is subtracted.

## Cleanup and visual checks

The supplied runner's earlier cleanup loop returned DOM nodes from waitForFunction, leaving Playwright handles retaining old trees. The corrected comparison returns a boolean. Across 12 six-embed mount cycles, final retained heap growth is 0.11 MiB before and 0.14 MiB after; metadata listeners return to zero after every unmount. End-of-workflow heap is 5.61 MiB for typical reviews, 11.69 MiB for 1,000 files, 42.96 MiB after visiting all 10,000 dense code rows, and 8.91 MiB for six embeds. Visited rows remain mounted to preserve selection and edits. The final report retains DOM counts, read counts, heap samples, and long-task snapshots.

The focused production test also renders Markdown, mounts/unmounts five times, waits for effects, and forces browser GC. Typical heap drops from 6.67 to 5.36 MiB after unmount; the 1,000-file heap drops from 16.19 to 7.79 MiB. The Node near-limit audit deliberately keeps a 30 MiB package and its fixture strings alive, so its 107.54 MiB compute heap is not a plugin retention measurement. These bounded checks do not establish behavior over an unlimited session.

Checked final production screenshots: [desktop](screenshots/durable-desktop.png), [1024 × 640 laptop](screenshots/durable-laptop.png), and [embed](screenshots/durable-embed.png). Native Obsidian GUI rendering and third-party theme/plugin interactions remain unverified; compiled-host and browser tests cover Markdown source-path propagation and component disposal. The final source passes the build, native package checks, 115 unit tests, and 49 browser tests. See the [independent review record](../docs/superpowers/reviews/2026-10-12-durable-reviews.md) for the four corrected findings and execution decisions.
