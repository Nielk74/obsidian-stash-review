# Stash Review

A pull request workspace for the changes you have parked in Git stashes. Open it in Obsidian, give each stash a useful title, and read the code with enough context to pick up where you left off.

![Stash Review's dark workspace with a stash list, collapsible changed-file tree, and syntax-highlighted code diff](docs/images/stash-review-dark.png)

The screenshots use the fictional browser Demo vault. [Light theme](docs/images/stash-review-light.png) · [Single file](docs/images/stash-review-focused.png) · [Split diff](docs/images/stash-review-split.png) · [Filtered tree](docs/images/stash-review-tree.png) · [Narrow workspace](docs/images/stash-review-narrow.png).

Stash Review runs on **Obsidian desktop 1.6 or later**, with Git installed on your computer. Your vault can be the repository, or you can review any other local Git repository from the same vault.

- Search stashes by their message, review title, description, or tags; pin the ones you want to revisit.
- Browse a collapsible folder tree of changed files, with directory review progress, change status, line counts, and a flat-list option. Search keeps matching files inside their folder hierarchy.
- Read syntax-highlighted unified or side-by-side diffs with line numbers, full-file context, and separate staged and unstaged layers. Choose all files together or one file at a time.
- Annotate a line or range, reply to a thread, resolve questions, and mark files reviewed.
- Create a stash, apply a saved stash with an optional index restore, remove a stash with a recoverable backup, or export your review to a Markdown note.
- Keep titles, tags, notes, and review progress across restarts and stash renumbering.

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

The test suite creates isolated temporary Git repositories to verify diff layers, stash identity, untracked files, mutation guards, and backup recovery. Browser tests exercise the review workflow and save screenshots as test artifacts. A package smoke test loads the compiled plugin against a minimal Obsidian API contract to check registration, persistence, and vault export. CI runs these checks before packaging a release. A native Obsidian GUI smoke test remains unverified on the headless development host.

For a release, update `package.json`, `manifest.json`, and `versions.json`, then push an annotated version tag such as `0.2.0`. The release workflow builds, tests, packages the plugin folder, and publishes assets using the GitHub CLI. Obsidian version tags have no `v` prefix.

MIT licensed.
