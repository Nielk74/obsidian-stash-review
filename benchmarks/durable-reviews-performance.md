# Durable review performance audit

Measured on Windows 11, AMD Ryzen 7 9800X3D, 16 logical CPUs, 31.1 GiB RAM, Git 2.50.1.windows.1, Node 24.5.0, and Chromium 156.0.8078.4. Node 22 remains the development target; this run does not establish Node 22 runtime results. Browser tests use production React bundles, a synthetic host, a 1440 × 900 viewport, and 1× CPU. Real Git and the compiled native host are measured separately.

The baseline is commit `a30ede4`, containing the supplied performance work, before durable-review source changes. The final UI comparison uses `8d79fac`; every JSON report retains source/bundle hashes and raw samples. Existing reports and the original benchmark runner remain intact. `durable-before/after-five-*` use five samples for otherwise capped heavy workloads. Initial single-sample plugin evaluation is a size/startup observation, not a reliable p95.

## Existing workloads

| Workload | Before median / p95 (ms) | After median / p95 (ms) |
| --- | ---: | ---: |
| Typical initial paint | 82.3 / 168.4 | 82.8 / 170.8 |
| 1,000-file initial paint | 181.9 / 209.3 | 162.0 / 244.5 |
| Six-embed initial paint | 98.8 / 159.9 | 98.2 / 165.6 |
| 1,000-file All layer switch | 47.8 / 48.1 | 47.6 / 48.5 |
| Dense 5,000-line Unstaged switch | 83.8 / 91.0 | 86.7 / 93.7 |
| Dense 5,000-line All switch | 84.6 / 86.3 | 90.8 / 101.8 |
| Six identical native diff readers, cold cache | 449.438 / 473.201 | 453.828 / 575.877 |
| Repeated native diff read, retained cache | 0.001 / 0.001 | 0.001 / 0.001 |
| Native metadata save, 1,000 reviews | 27.694 / 28.195 | 25.156 / 30.224 |
| Wrap after visiting every dense diff row | 1,435.5 / 1,644.1 | 1,181.2 / 1,735.1 |

Typical existing actions stay at or below 34.5 ms p95. The 1,000-file and six-embed existing actions stay at or below 72.7 and 35.2 ms p95 respectively. The browser bundle grew from 486,173 to 501,086 bytes (gzip: 152,351 → 156,747); the compiled native bundle grew from 1,007,648 to 1,048,136 bytes. No runtime dependency was added.

The first native diff sample now creates its retention reference and saves a compressed snapshot. Across five cold-cache batches, Git command count is 30 → 32, while six concurrent readers still share one diff operation. Median cost is similar, but first-read retention contributes to the higher p95. Retention is intentionally kept because it protects original reviewed objects after external stash removal.

The initial dense layer comparison exposed eager search indexing. A browser regression counted 40,200 diff-text accesses before any query. Lazy indexing over the canonical snapshot fixed that unnecessary work and preserves index reuse during typing and source hydration. The final comparison also has an isolated context-change sample at 129.5 ms (median 69.0, baseline median 67.6); dense Staged switching and fully visited wrap changes exceed the ordinary 100 ms interaction target. These heavy cases remain documented limitations rather than a claim of uniform speed.

Raw reports: [before compute](results/durable-before-compute.json), [after compute](results/durable-after-compute.json), [before native/Git](results/durable-before-five-git.json), [after native/Git](results/durable-after-five-git.json), [before browser](results/durable-before-five-browser.json), [after browser](results/durable-after-five-browser.json). Earlier three-sample heavy measurements remain available for traceability, but the table uses the five-sample comparisons.

## New workflows

All values below use five samples. Library-only measurements use in-memory storage; they exclude disk and Git spawn costs.

| Workload | Median / p95 (ms) |
| --- | ---: |
| Build literal-search index, 1,000 files | 0.718 / 1.075 |
| Search indexed text, 1,000 files | 0.258 / 0.403 |
| Build literal-search index, 5,000 files | 3.860 / 4.876 |
| Whitespace presentation, 5,000 files | 6.906 / 7.247 |
| Browse 1,000 archive descriptors | 0.372 / 0.550 |
| Read 1,000 archive summaries | 0.214 / 0.229 |
| Continue an exact matching 1,000-file revision | 92.080 / 93.417 |
| Typical portable export/import | 2.855 / 3.315 |
| Validate a 30,302,002-byte portable package | 38.335 / 46.458 |
| Typical search response including debounce | 132.1 / 132.7 |
| Typical search response excluding 100 ms debounce | 32.1 / 32.7 |
| 1,000-file search excluding debounce | 29.2 / 44.8 |
| Typical whitespace toggle | 32.1 / 33.6 |
| Typical archive page switch | 31.5 / 33.3 |

The [focused report](results/durable-focused.json) asserts that six identical immutable readers issue one underlying diff operation and one snapshot write; archive descriptors read no snapshots; search, whitespace, and archive paging issue no diff reads; and archive pages contain 50 entries. It records no uncaught browser errors. Search timings include two animation frames and a conservative 110 ms measurement wait; only the deliberate 100 ms debounce is subtracted.

## Cleanup and visual checks

The supplied runner's original cleanup loop returned DOM nodes from `waitForFunction`, leaving Playwright handles retaining old trees. The derived comparison returns a boolean instead. Across 12 six-embed mount cycles, corrected growth is 0.11 MiB before and 0.12 MiB after; the original baseline's 9.79 MiB was retained test handles. [Corrected before](results/durable-before-cleanup.json) and [corrected after](results/durable-after-cleanup.json) retain the samples; metadata listeners return to zero after every unmount.

The focused production test also rendered Markdown, mounted/unmounted five times, waited for effects, and forced browser GC. Typical heap dropped from 6.60 to 5.34 MiB after unmount; the 1,000-file heap dropped from 21.10 to 7.79 MiB. The Node near-limit audit deliberately keeps a 30 MiB package and its fixture strings alive, so its 107.47 MiB compute heap is not a plugin retention measurement.

Checked production screenshots: [desktop](screenshots/durable-desktop.png), [1024 × 640 laptop](screenshots/durable-laptop.png), and [embed](screenshots/durable-embed.png). Native Obsidian GUI rendering and third-party theme/plugin interactions remain unverified; the compiled-host contract and browser workflow suites cover the implemented integration.
