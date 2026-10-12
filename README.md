# Stash Review

A pull request workspace for the changes you have parked in Git stashes. Open it in Obsidian, give each stash a useful title, and read the code with enough context to pick up where you left off.

![Stash Review's dark workspace with a stash list, collapsible changed-file tree, and syntax-highlighted code diff](docs/images/stash-review-dark.png)

The screenshots use the fictional browser Demo vault. [Laptop layout](docs/images/stash-review-laptop.png) · [Markdown embed](docs/images/stash-review-embed.png) · [Light theme](docs/images/stash-review-light.png) · [Single file](docs/images/stash-review-focused.png) · [Split diff](docs/images/stash-review-split.png) · [Filtered tree](docs/images/stash-review-tree.png) · [Narrow workspace](docs/images/stash-review-narrow.png).

Stash Review runs on **Obsidian desktop 1.6 or later**, with Git installed on your computer. Your vault can be the repository, or you can review any other local Git repository from the same vault.

- Search stashes by their message, review title, description, or tags; pin the ones you want to revisit.
- Browse a collapsible folder tree of changed files, with directory review progress, change status, line counts, and a flat-list option. Search keeps matching files inside their folder hierarchy.
- Read syntax-highlighted unified or side-by-side diffs with line numbers, full-file context, and separate staged and unstaged layers. Choose all files together or one file at a time.
- Annotate a line or range, reply to a thread, resolve questions, and mark files reviewed.
- Create a stash, apply a saved stash with an optional index restore, remove a stash with a recoverable backup, or export your review to a Markdown note.
- Keep titles, tags, notes, and review progress across restarts and stash renumbering.
- Link to an exact stash from an Obsidian note, or embed an interactive review directly in Markdown.

## Install

Download **`stash-review-0.2.0.zip`** from the [latest GitHub release](https://github.com/Nielk74/obsidian-stash-review/releases/latest). Extract the `stash-review` folder into:

```text
YOUR_VAULT/.obsidian/plugins/stash-review/
  main.js
  manifest.json
  styles.css
```

In Obsidian, open **Settings → Community plugins**, enable community plugins if needed, and enable **Stash Review**. Use the Git pull request ribbon icon or run **Stash Review: Open stash review** from the command palette.

To update an existing installation, replace only `main.js`, `manifest.json`, and `styles.css`, then disable and enable Stash Review. Keep `data.json` in place to preserve your annotations, titles, tags, and review progress.

You can also install through [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `Nielk74/obsidian-stash-review` as a beta plugin. This plugin is distributed through GitHub releases; it is not yet listed in Obsidian's community plugin directory. Release assets include the individual plugin files and `SHA256SUMS` for checksum verification.

## Use it

If your vault is in a Git repository, the plugin discovers it when no other repositories are configured. Otherwise, add an absolute repository folder path in the review workspace or in **Settings → Stash Review → Repositories**. Configure an absolute Git executable path if Obsidian cannot find `git`, such as `/opt/homebrew/bin/git` on an Apple Silicon Mac.

Choose a stash and give it a title that explains the idea. Add a short description and tags; these change your review metadata and preserve the original Git stash message. Switch between **All changes**, **Staged**, and **Unstaged** to see what was in the index and working tree when the stash was made. Captured untracked files appear in the appropriate saved working-tree view. Binary files display their status instead of a text diff.

The **Files changed** sidebar shows changed paths in their actual folder hierarchy. Folders come before files at each level; files with the same name keep their own path and review state. Expand or collapse folders, or switch between **Tree** and **List**. Search shows matching paths with their ancestors expanded, then restores your folder choices when you clear it. Folder choices survive reopening the workspace.

Choose **All files** for a continuous review, or **Single file** to focus on the selected path. The file tree stays available in either mode, and the previous/next controls move between matching files. Collapse individual diffs or all files when you want to scan headers. Marking a file **Viewed** collapses its diff and updates progress in its parent folders. **Hide viewed files** filters the completed files while retaining your annotations and progress.

Use a line's comment control to leave a note. Select a range with Shift when you want to discuss several lines. Threads belong to a specific file, line side, and diff layer. Selecting an annotation's location returns to its saved layer, reveals its file even when filtered or collapsed, and shows the original anchor. Expand file context to read surrounding saved code, then export the discussion into your vault when you want a standalone note.

On a laptop or in a narrow Obsidian pane, the stash list and file tree open as drawers so code can use the available width. Close them with Escape or by clicking outside. Short panes collapse secondary stash details; **Show stash details** reveals the description, tags, and capture information. **Wrap code lines** avoids horizontal scrolling in a unified diff. Select code text normally to copy it without diff signs or line numbers; in split view, copying a vertical selection keeps the selected side. A file header's copy button copies the full saved file, or its original contents for a deleted file.

## Link or embed a review in a note

Open **More stash actions → Copy Markdown link**, then paste into any Obsidian note. Clicking the link opens the review tab at that exact repository, stash, and diff layer. In **Single file** mode the link also remembers the selected path. Links use the full stash commit hash, so creating or removing other stashes cannot redirect them to a different `stash@{n}`.

Choose **Copy Markdown embed** to paste an interactive review inside the note instead. This copies a fenced `stash-review` block containing the same URL. The block renders in Reading view and rendered Live Preview blocks, with file navigation, diffs, annotations, and viewed-file controls. **Open full review** opens that snapshot in the plugin tab. Embeds and tabs share review metadata, including edits made while another view is saving.

For a manually written block, use `repo: <repository ID>` and `stash: <full commit hash>` on separate lines. Optional fields are `layer: all`, `staged`, or `unstaged`, and `file: <path>`. Copying the link or embed is easier because it supplies the correct identifiers. An invalid definition displays an explanation; an unavailable stash or file never silently opens a different target.

Links refer to configured local repositories in the named vault. After moving or cloning a repository to a different location, configure it and copy a fresh link. Exported review notes also include a link back to the live review.

Within the file tree, use **↑/↓** to move, **→/←** to expand or collapse a folder and move between parents and children, **Home/End** to reach the first or last item, and **Enter/Space** to open a file. Stash shortcuts **j/k** continue to work in the stash list; file navigation and text fields keep their own keyboard behavior.

The review layout follows the compact diff headers, viewed-file controls, and folder navigation documented by [GitHub](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request) and [Bitbucket](https://support.atlassian.com/bitbucket-cloud/docs/review-code-in-a-pull-request/), including Bitbucket's choice of all-file and individual-file review.

Applying requires a clean working tree and preserves the saved stash. You can choose whether to restore the original index. If Git reports a conflict, inspect and resolve the working tree before trying again; Git can leave partially applied files. Creating a stash can include untracked files when selected. Ignored files are excluded.

When your vault is the repository, the running plugin's installation folder and review data stay in place. Creating a stash excludes that folder. If protected plugin files are staged, creation and application stop before changing the repository and ask you to unstage them. Applying ignores unstaged and untracked changes within that protected folder when checking for a clean tree, and refuses a stash that contains changes to those plugin files. All other local changes still block application. Adding `.obsidian/plugins/stash-review/` to your vault repository's `.gitignore` keeps generated plugin files and review data out of future commits; use your configured vault folder name if it differs from `.obsidian`.

Removing a stash asks for confirmation. Before removal, the plugin creates a Git reference at **`refs/stash-review/backups/<stash-hash>`** so Git retains the object. The workspace offers Undo. These backup references remain in your repository until you remove them yourself. To find retained backups and recover one manually:

```sh
git for-each-ref refs/stash-review/backups/
git stash store -m "Recovered stash" refs/stash-review/backups/STASH_HASH
```

The plugin identifies reviews by the repository's common Git directory and immutable stash object hash, so notes survive changes to `stash@{n}` and remain consistent across linked worktrees. Plugin settings and review metadata are stored in your vault's **`.obsidian/plugins/stash-review/data.json`**, or the corresponding path under a custom vault configuration folder. They may be included in any sync or backup system that copies this file. The plugin does not send repository contents or annotations to a server. Git operations are local and use the configured Git executable.

Git operations from plugin tabs are serialized across linked worktrees. Other Git programs can still change the stash list. The plugin rechecks stash identity before removal and verifies the result afterward; if it detects an unexpected removal, it preserves a backup reference and reports the concurrent change. Refresh the list before continuing.

## Develop and preview

Use Node.js 22 and Git:

```sh
npm ci
npm run build
npm test
npm run test:package
npx playwright install chromium
npm run test:e2e
```

`npm run dev` rebuilds the desktop plugin while you work. Copy the built `main.js`, `manifest.json`, and `styles.css` into a test vault's plugin folder to load it in Obsidian.

`npm run preview` serves the same React review workspace at `http://127.0.0.1:4173`. It uses a clearly marked **Demo vault** with fictional Git snapshots. Demo mutations and annotations persist in browser localStorage; the preview never reads or changes your local repositories. Clear that site's storage to reset it. Add `?theme=light` for a light theme, or `?state=empty`, `?state=error`, and `?state=diff-error` to inspect fallback screens.

To preview a review embedded in a note, use `?embed=1&repo=demo-fieldbook&stash=8d7be6a901afe7794ed9a6f1a3cb0318409876da`; `embed=2` shows two instances sharing metadata. The optional `layer` and `file` parameters select a saved layer and path. The workspace caches syntax output within a bounded memory budget, skips highlighting collapsed files, and keeps very large generated files readable as plain code to avoid expensive tokenization.

The test suite creates isolated temporary Git repositories to verify diff layers, stash identity, untracked files, mutation guards, and backup recovery. Browser tests exercise the review workflow and save screenshots as test artifacts. A package smoke test loads the compiled plugin against a minimal Obsidian API contract to check registration, persistence, and vault export. CI runs these checks before packaging a release. A native Obsidian GUI smoke test remains unverified on the headless development host.

Run the performance audit separately from tests so other workloads do not distort timings:

```sh
npm run benchmark -- --output benchmarks/results/latest.json
npm run benchmark -- --ref 0985990 --output benchmarks/results/baseline.json
npm run benchmark -- --section browser --cpu 4 --viewport 1366x768 --samples 9
```

The audit measures production UI rendering and interactions, real Git reads and mutations in a disposable repository, plugin initialization and persistence, syntax and parsing, memory, and embed cleanup. Browser workloads cover ordinary reviews, 1,000 files/stashes/annotations, sparse 20,000-line files, dense 5,000-line changes, and six embeds. Each JSON report includes hardware, source hashes, raw samples, median, p95, long tasks, and explicit timing targets. `--section compute|git|browser`, `--workloads typical,multi-embed`, and `--cpu 1,4` select subsets. A revision comparison reads committed sources without changing the checkout. Git mutations stay inside the verified temporary fixture directory.

Browser timings use a deterministic in-memory host to isolate rendering; real Git and the native plugin host are measured separately. CPU throttling approximates a slower machine, fresh pages/services retain operating-system disk caches, and single-sample actions do not establish a meaningful p95. These measurements do not replace testing inside Obsidian on the target laptop.

Large diffs mount nearby files and row groups first, retaining them once visited to preserve selections and edits. Clipboard selection reconstructs intervening unloaded code from the snapshot. Identical reads across embeds share pending requests; immutable diff/source results use a bounded 16 MiB cache, while repository and stash lists remain fresh on refresh.

For a release, update `package.json`, `manifest.json`, and `versions.json`, then push an annotated version tag such as `0.2.0`. The release workflow builds, tests, packages the plugin folder, and publishes assets using the GitHub CLI. Obsidian version tags have no `v` prefix.

MIT licensed.
