import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { DiffFile, DiffHunk, DiffLayer, Repository, Stash } from './types';

const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const repositoryQueues = new Map<string, Promise<unknown>>();
const hashPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class GitError extends Error {
  constructor(message: string, readonly details = '') {
    super(message);
    this.name = 'GitError';
  }
}

interface FileMetadata {
  path: string;
  oldPath?: string;
  status: DiffFile['status'];
}

function assertHash(hash: string): void {
  if (!hashPattern.test(hash)) throw new GitError('Invalid stash commit ID. Refresh the stash list.');
}

function assertPath(path: string): void {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.')) {
    throw new GitError('Invalid file path in the stash.');
  }
}

function decodeGitPath(path: string): string {
  if (!path.startsWith('"')) return path;
  // Git quoting includes octal UTF-8 bytes, which JSON.parse cannot decode.
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, '"': 34 };
  const raw = path.slice(1, -1);
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === '\\') {
      const octal = raw.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) {
        bytes.push(parseInt(octal, 8));
        index += octal.length;
      } else {
        bytes.push(escapes[raw[++index]] ?? raw.charCodeAt(index));
      }
    } else {
      const point = raw.codePointAt(index)!;
      bytes.push(...Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) index++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerPath(value: string): string | undefined {
  const decoded = decodeGitPath(value);
  return decoded === '/dev/null' ? undefined : decoded.replace(/^[ab]\//, '');
}

/** Parse a standard Git patch; raw NUL-delimited metadata supplies lossless paths. */
export function parseDiff(patch: string, metadata: FileMetadata[] = [], untracked = false): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let metadataIndex = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const known = metadata[metadataIndex++];
      // File headers below disambiguate ordinary paths containing spaces.
      const paths = line.slice(11).match(/^("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/);
      const oldPath = paths ? headerPath(paths[1]) : undefined;
      const newPath = paths ? headerPath(paths[2]) : undefined;
      file = {
        path: known?.path ?? newPath ?? oldPath ?? 'unknown',
        oldPath: known?.oldPath,
        status: known?.status ?? 'modified',
        additions: 0, deletions: 0, binary: false, untracked, hunks: []
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      hunk = {
        header: line,
        oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: []
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      if (line.startsWith('+')) {
        hunk.lines.push({ type: 'add', text: line.slice(1), newLine: newLine++ });
        file.additions++;
      } else if (line.startsWith('-')) {
        hunk.lines.push({ type: 'delete', text: line.slice(1), oldLine: oldLine++ });
        file.deletions++;
      } else if (line.startsWith(' ')) {
        hunk.lines.push({ type: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
      } else if (line.startsWith('\\ No newline')) {
        hunk.lines.push({ type: 'info', text: line });
      }
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
    if (!metadata.length) {
      if (line.startsWith('new file mode ')) file.status = 'added';
      if (line.startsWith('deleted file mode ')) file.status = 'deleted';
      if (line.startsWith('rename from ')) {
        file.oldPath = decodeGitPath(line.slice(12));
        file.status = 'renamed';
      }
      if (line.startsWith('rename to ')) file.path = decodeGitPath(line.slice(10));
      if (line.startsWith('--- ')) {
        const path = headerPath(line.slice(4));
        if (path && file.status !== 'renamed') file.path = path;
        if (!path) file.status = 'added';
      }
      if (line.startsWith('+++ ')) {
        const path = headerPath(line.slice(4));
        if (path) file.path = path;
        else file.status = 'deleted';
      }
    }
  }
  if (metadata.length && files.length !== metadata.length) {
    throw new GitError('Git returned an incomplete patch. Try a smaller amount of context.');
  }
  return files;
}

function parseNameStatus(output: string): FileMetadata[] {
  const fields = output.split('\0');
  const files: FileMetadata[] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    const first = fields[index++];
    if (first === undefined) throw new GitError('Git returned invalid file metadata.');
    if (status.startsWith('R')) {
      const path = fields[index++];
      if (path === undefined) throw new GitError('Git returned invalid rename metadata.');
      files.push({ path, oldPath: first, status: 'renamed' });
    } else {
      files.push({ path: first, status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified' });
    }
  }
  return files;
}

/** Desktop-only Git operations. Commands never invoke a shell or change cwd globally. */
export class GitService {
  private readonly commonDirectories = new Map<string, string>();

  constructor(private readonly gitPath = 'git') {
    if (!gitPath || gitPath.includes('\0')) throw new GitError('Set a valid Git executable in settings.');
  }

  private async run(path: string, args: string[]): Promise<string> {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_NO_REPLACE_OBJECTS = '1';
    env.GIT_OPTIONAL_LOCKS = '0';
    env.LC_ALL = 'C';
    const options = [
      '--no-pager', ...(args[0] === 'diff' || args[0] === 'ls-tree' ? ['--literal-pathspecs'] : []), '-C', path,
      '-c', 'color.ui=false', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false',
      '-c', 'diff.external=', '-c', 'diff.noprefix=false', '-c', 'diff.suppressBlankEmpty=false', ...args
    ];
    return new Promise((resolveCommand, reject) => {
      const child = execFile(this.gitPath, options, { encoding: 'utf8', env, timeout: 30_000, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          const details = stderr.trim() || error.message;
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
          reject(new GitError(missing ? 'Git was not found. Set the Git executable path in settings.' : `Git could not ${args[0] === 'diff' ? 'read this diff' : 'complete this operation'}. ${details}`, details));
        } else resolveCommand(stdout);
      });
      child.stdin?.end();
    });
  }

  private async locked<T>(repository: Repository, operation: () => Promise<T>): Promise<T> {
    let key = this.commonDirectories.get(repository.path);
    if (!key) {
      const common = (await this.run(repository.path, ['rev-parse', '--git-common-dir'])).replace(/\r?\n$/, '');
      key = await realpath(resolve(repository.path, common));
      this.commonDirectories.set(repository.path, key);
    }
    const previous = repositoryQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    repositoryQueues.set(key, next);
    try { return await next; }
    finally { if (repositoryQueues.get(key) === next) repositoryQueues.delete(key); }
  }

  async resolveRepository(path: string): Promise<Repository> {
    if (!path || path.includes('\0')) throw new GitError('Choose a Git repository folder.');
    const root = (await this.run(resolve(path), ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
    const canonical = await realpath(root);
    const common = (await this.run(canonical, ['rev-parse', '--git-common-dir'])).replace(/\r?\n$/, '');
    const commonDirectory = await realpath(resolve(canonical, common));
    this.commonDirectories.set(canonical, commonDirectory);
    const repository: Repository = {
      id: createHash('sha256').update(commonDirectory).digest('hex').slice(0, 24),
      path: canonical, name: basename(canonical), branch: '', dirty: false
    };
    return this.locked(repository, async () => {
      try { repository.branch = (await this.run(canonical, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim(); }
      catch { repository.branch = `detached at ${(await this.run(canonical, ['rev-parse', '--short', 'HEAD'])).trim()}`; }
      repository.dirty = (await this.run(canonical, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).length > 0;
      return repository;
    });
  }

  private async readStashes(repository: Repository): Promise<Stash[]> {
    const output = await this.run(repository.path, ['stash', 'list', '--format=%H%x00%gd%x00%gs%x00%cI%x00%P%x00']);
    const fields = output.split('\0');
    const result: Stash[] = [];
    for (let index = 0; index + 4 < fields.length; index += 5) {
      const hash = fields[index].replace(/^\n+/, '');
      if (!hash) continue;
      assertHash(hash);
      const subject = fields[index + 2];
      const match = subject.match(/^(?:WIP on|On) ([^:]+): (.*)$/s);
      result.push({
        hash, ref: fields[index + 1], message: match?.[2] ?? subject,
        branch: match?.[1] ?? '', createdAt: fields[index + 3], baseHash: fields[index + 4].split(' ')[0]
      });
    }
    return result;
  }

  async listStashes(repository: Repository): Promise<Stash[]> {
    return this.locked(repository, () => this.readStashes(repository));
  }

  private async snapshot(repository: Repository, stash: Stash): Promise<{ base: string; index: string; working: string; untracked?: string }> {
    assertHash(stash.hash);
    const parents = (await this.run(repository.path, ['rev-list', '--parents', '-n', '1', stash.hash, '--'])).trim().split(' ');
    if (parents.length < 3 || parents[0] !== stash.hash) throw new GitError('This commit is not a valid Git stash. Refresh the stash list.');
    return { working: parents[0], base: parents[1], index: parents[2], untracked: parents[3] };
  }

  private trees(snapshot: { base: string; index: string; working: string }, layer: DiffLayer): [string, string] {
    if (layer === 'all') return [snapshot.base, snapshot.working];
    if (layer === 'staged') return [snapshot.base, snapshot.index];
    if (layer === 'unstaged') return [snapshot.index, snapshot.working];
    throw new GitError('Choose a valid diff layer.');
  }

  private async treeDiff(repository: Repository, oldTree: string, newTree: string, context: number, untracked = false): Promise<DiffFile[]> {
    const shared = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--find-renames', '--submodule=short', '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/', oldTree, newTree, '--'];
    const metadata = parseNameStatus(await this.run(repository.path, ['diff', '--name-status', '-z', ...shared]));
    if (!metadata.length) return [];
    const patch = await this.run(repository.path, ['diff', '--patch', `--unified=${context}`, ...shared]);
    return parseDiff(patch, metadata, untracked);
  }

  async getDiff(repository: Repository, stash: Stash, layer: DiffLayer, context = 5): Promise<DiffFile[]> {
    if (!Number.isInteger(context) || context < 0 || context > 500) throw new GitError('Diff context must be between 0 and 500 lines.');
    return this.locked(repository, async () => {
      const snapshot = await this.snapshot(repository, stash);
      const [oldTree, newTree] = this.trees(snapshot, layer);
      const tracked = await this.treeDiff(repository, oldTree, newTree, context);
      if (!snapshot.untracked || layer === 'staged') return tracked;
      // Empty tree ID is derived by Git so SHA-256 repositories work as well.
      const emptyTree = (await this.run(repository.path, ['hash-object', '-t', 'tree', '--stdin'])).trim();
      const untracked = await this.treeDiff(repository, emptyTree, snapshot.untracked, context, true);
      return [...tracked, ...untracked];
    });
  }

  private async content(repository: Repository, commit: string | undefined, path: string): Promise<{ text: string; truncated: boolean }> {
    if (!commit) return { text: '', truncated: false };
    assertPath(path);
    const output = await this.run(repository.path, ['ls-tree', '-z', commit, '--', path]);
    const record = output.split('\0').find(entry => entry.slice(entry.indexOf('\t') + 1) === path);
    if (!record) return { text: '', truncated: false };
    const [mode, type, hash] = record.slice(0, record.indexOf('\t')).split(' ');
    if (type !== 'blob' || mode === '160000') return { text: '', truncated: false };
    const size = Number((await this.run(repository.path, ['cat-file', '-s', hash])).trim());
    if (size > MAX_CONTENT_BYTES) return { text: '', truncated: true };
    return { text: await this.run(repository.path, ['cat-file', 'blob', hash]), truncated: false };
  }

  async getFileContents(repository: Repository, stash: Stash, file: DiffFile, layer: DiffLayer): Promise<{ oldContent: string; newContent: string; truncated?: boolean }> {
    return this.locked(repository, async () => {
      assertPath(file.path);
      if (file.oldPath) assertPath(file.oldPath);
      const snapshot = await this.snapshot(repository, stash);
      const [oldTree, newTree] = this.trees(snapshot, layer);
      if (file.binary) return { oldContent: '', newContent: '' };
      const oldContent = file.untracked ? { text: '', truncated: false } : await this.content(repository, oldTree, file.oldPath ?? file.path);
      const newContent = await this.content(repository, file.untracked ? snapshot.untracked : newTree, file.path);
      return { oldContent: oldContent.text, newContent: newContent.text, truncated: oldContent.truncated || newContent.truncated };
    });
  }

  async createStash(repository: Repository, message: string, includeUntracked: boolean, protectedPaths: string[] = []): Promise<void> {
    if (typeof message !== 'string' || message.includes('\0') || message.length > 2000) throw new GitError('Use a stash message of at most 2,000 characters.');
    if (!Array.isArray(protectedPaths)) throw new GitError('Protected plugin folders must be relative repository paths.');
    for (const path of protectedPaths) assertPath(path);
    return this.locked(repository, async () => {
      if (protectedPaths.length) {
        const stagedPluginFiles = await this.run(repository.path, ['diff', '--cached', '--ita-visible-in-index', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--', ...protectedPaths]);
        // Git stash snapshots the whole index even with exclusion pathspecs.
        // Refuse before mutation rather than capturing plugin data implicitly.
        if (stagedPluginFiles) throw new GitError('Unstage Stash Review plugin files before creating a stash. Your changes have been kept.');
      }
      const pathspecs = protectedPaths.length ? ['--', '.', ...protectedPaths.map(path => `:(exclude,literal)${path}`)] : [];
      const result = await this.run(repository.path, ['stash', 'push', ...(includeUntracked ? ['--include-untracked'] : []), '--message', message.trim() || 'Saved from Stash Review', ...pathspecs]);
      // Git may reuse an existing commit and skip a reflog update for identical
      // snapshots created in the same second, even though it saved/cleaned work.
      if (/(?:^|\n)No local changes to save(?:\r?\n|$)/.test(result)) throw new GitError('Nothing to stash. There are no eligible changes in this repository.');
    });
  }

  async applyStash(repository: Repository, stash: Stash, restoreIndex: boolean, protectedPaths: string[] = []): Promise<void> {
    if (!Array.isArray(protectedPaths)) throw new GitError('Protected plugin folders must be relative repository paths.');
    for (const path of protectedPaths) assertPath(path);
    return this.locked(repository, async () => {
      const snapshot = await this.snapshot(repository, stash);
      if (protectedPaths.length) {
        const diffOptions = ['--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none'];
        const workingChanges = await this.run(repository.path, ['diff', ...diffOptions, snapshot.base, snapshot.working, '--', ...protectedPaths]);
        const stagedChanges = await this.run(repository.path, ['diff', ...diffOptions, snapshot.base, snapshot.index, '--', ...protectedPaths]);
        const untrackedChanges = snapshot.untracked ? await this.run(repository.path, ['ls-tree', '-r', '--name-only', '-z', snapshot.untracked, '--', ...protectedPaths]) : '';
        if (workingChanges || stagedChanges || untrackedChanges) {
          throw new GitError('This stash changes Stash Review plugin files. Apply it outside the plugin to protect the running plugin and your review data. The stash has been kept.');
        }
        const stagedPluginFiles = await this.run(repository.path, ['diff', '--cached', '--ita-visible-in-index', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--', ...protectedPaths]);
        // --index may reset unrelated index entries before a merge failure.
        // Keep staged plugin metadata untouched by rejecting before apply.
        if (stagedPluginFiles) throw new GitError('Unstage Stash Review plugin files before applying a stash. Your changes have been kept.');
      }
      const pathspecs = protectedPaths.length ? ['--', '.', ...protectedPaths.map(path => `:(exclude,literal)${path}`)] : [];
      const dirty = await this.run(repository.path, ['status', '--porcelain=v1', '-z', protectedPaths.length ? '--untracked-files=all' : '--untracked-files=normal', ...pathspecs]);
      if (dirty) throw new GitError('Save or stash your current changes before applying a stash. The working tree must be clean.');
      try { await this.run(repository.path, ['stash', 'apply', ...(restoreIndex ? ['--index'] : []), stash.hash]); }
      catch (error) {
        throw new GitError('Git could not apply the stash cleanly. It is still saved; inspect the working tree for conflicts or partially applied files before trying again.', error instanceof GitError ? error.details : String(error));
      }
    });
  }

  private backupRef(hash: string): string {
    assertHash(hash);
    return `refs/stash-review/backups/${hash}`;
  }

  async dropStash(repository: Repository, stash: Stash): Promise<void> {
    return this.locked(repository, async () => {
      await this.snapshot(repository, stash);
      const before = await this.readStashes(repository);
      const current = before.find(entry => entry.hash === stash.hash && entry.ref === stash.ref) ?? before.find(entry => entry.hash === stash.hash);
      if (!current) throw new GitError('This stash is no longer on the stash list. Refresh before removing it.');
      await this.run(repository.path, ['update-ref', this.backupRef(stash.hash), stash.hash]);
      // Resolve its current index immediately before removal; UI indices may be stale.
      const verified = await this.readStashes(repository);
      const target = verified.find(entry => entry.hash === current.hash && entry.ref === current.ref);
      if (!target) throw new GitError('The stash list changed while preparing removal. The stash was preserved; refresh and try again.');
      await this.run(repository.path, ['stash', 'drop', '--quiet', target.ref]);
      const after = await this.readStashes(repository);
      const remaining = new Map<string, number>();
      for (const entry of after) remaining.set(entry.hash, (remaining.get(entry.hash) ?? 0) + 1);
      const expected = verified.filter((_, index) => index !== verified.indexOf(target));
      const unexpected: Stash[] = [];
      for (const entry of expected) {
        const count = remaining.get(entry.hash) ?? 0;
        if (count) remaining.set(entry.hash, count - 1);
        else unexpected.push(entry);
      }
      if (unexpected.length || (after.filter(entry => entry.hash === stash.hash).length !== verified.filter(entry => entry.hash === stash.hash).length - 1)) {
        for (const entry of unexpected) await this.run(repository.path, ['update-ref', this.backupRef(entry.hash), entry.hash]);
        throw new GitError('Concurrent Git activity changed the stash list during removal. Removed stashes were preserved in refs/stash-review/backups; refresh the list before continuing.');
      }
    });
  }

  async restoreDroppedStash(repository: Repository, stash: Stash): Promise<void> {
    return this.locked(repository, async () => {
      assertHash(stash.hash);
      const backup = (await this.run(repository.path, ['rev-parse', '--verify', this.backupRef(stash.hash)])).trim();
      if (backup !== stash.hash) throw new GitError('The saved stash backup does not match this review.');
      if ((await this.readStashes(repository)).some(entry => entry.hash === stash.hash)) return;
      await this.run(repository.path, ['stash', 'store', '--message', `On ${stash.branch || 'restored'}: ${stash.message}`, stash.hash]);
    });
  }
}
