import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/git';

const folders: string[] = [];
const service = new GitService();

function git(path: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return execFileSync('git', ['--literal-pathspecs', '-C', path, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function repository(sha256 = false): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stash-review-tests-'));
  folders.push(path);
  git(path, 'init', '--initial-branch=main', ...(sha256 ? ['--object-format=sha256'] : []));
  git(path, 'config', 'user.name', 'Stash Review Tests');
  git(path, 'config', 'user.email', 'tests@example.invalid');
  await writeFile(join(path, 'example.ts'), 'const staged = 1;\nconst working = 1;\n');
  git(path, 'add', '--', 'example.ts');
  git(path, 'commit', '--quiet', '-m', 'Initial snapshot');
  return path;
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('GitService against real temporary repositories', () => {
  it('separates all, staged, unstaged and untracked snapshots with immutable full context', async () => {
    const path = await repository();
    await writeFile(join(path, 'example.ts'), 'const staged = 2;\nconst working = 1;\n');
    git(path, 'add', '--', 'example.ts');
    await writeFile(join(path, 'example.ts'), 'const staged = 2;\nconst working = 3;\n');
    const specialPath = 'café "ideas"\nnext.ts';
    await writeFile(join(path, specialPath), 'export const idea = true;\n');
    const repo = await service.resolveRepository(path);
    expect(repo).toMatchObject({ path: await realpath(path), branch: 'main', dirty: true });
    await service.createStash(repo, 'Keep my experiment', true);
    const [stash] = await service.listStashes(repo);
    expect(stash).toMatchObject({ message: 'Keep my experiment', branch: 'main', ref: 'stash@{0}' });
    const all = await service.getDiff(repo, stash, 'all', 5);
    const staged = await service.getDiff(repo, stash, 'staged', 0);
    const unstaged = await service.getDiff(repo, stash, 'unstaged', 0);
    expect(all.map(file => file.path)).toEqual(['example.ts', specialPath]);
    expect(staged).toHaveLength(1);
    expect(staged[0].hunks[0].lines).toEqual([
      { type: 'delete', text: 'const staged = 1;', oldLine: 1 },
      { type: 'add', text: 'const staged = 2;', newLine: 1 }
    ]);
    expect(unstaged[0].hunks[0].lines).toEqual([
      { type: 'delete', text: 'const working = 1;', oldLine: 2 },
      { type: 'add', text: 'const working = 3;', newLine: 2 }
    ]);
    expect(all[1]).toMatchObject({ status: 'added', untracked: true, additions: 1 });
    await writeFile(join(path, 'example.ts'), 'Current working tree must stay untouched.\n');
    expect(await service.getFileContents(repo, stash, all[0], 'all')).toMatchObject({
      oldContent: 'const staged = 1;\nconst working = 1;\n',
      newContent: 'const staged = 2;\nconst working = 3;\n', truncated: false
    });
    expect(await service.getFileContents(repo, stash, staged[0], 'staged')).toMatchObject({
      oldContent: 'const staged = 1;\nconst working = 1;\n', newContent: 'const staged = 2;\nconst working = 1;\n'
    });
    expect(await service.getFileContents(repo, stash, unstaged[0], 'unstaged')).toMatchObject({
      oldContent: 'const staged = 2;\nconst working = 1;\n', newContent: 'const staged = 2;\nconst working = 3;\n'
    });
    expect(await service.getFileContents(repo, stash, all[1], 'all')).toMatchObject({ oldContent: '', newContent: 'export const idea = true;\n' });
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('Current working tree must stay untouched.\n');
  });

  it('reads renames, deleted files, binary data, and literal pathspec-like names', async () => {
    const path = await repository();
    await writeFile(join(path, 'old name.txt'), 'a reusable name\n');
    await writeFile(join(path, 'deleted.txt'), 'deleted content\n');
    await writeFile(join(path, 'binary.dat'), Buffer.from([0, 1, 2]));
    await writeFile(join(path, ':(glob)literal.ts'), 'const value = 1;\n');
    git(path, 'add', '--all');
    git(path, 'commit', '--quiet', '-m', 'More files');
    await rename(join(path, 'old name.txt'), join(path, 'new name.txt'));
    await rm(join(path, 'deleted.txt'));
    await writeFile(join(path, 'binary.dat'), Buffer.from([0, 4, 5]));
    await writeFile(join(path, ':(glob)literal.ts'), 'const value = 2;\n');
    git(path, 'add', '--all');
    const repo = await service.resolveRepository(path);
    await service.createStash(repo, 'Paths and binary', false);
    const [stash] = await service.listStashes(repo);
    const files = await service.getDiff(repo, stash, 'all', 3);
    expect(files.find(file => file.path === 'new name.txt')).toMatchObject({ oldPath: 'old name.txt', status: 'renamed', additions: 0, deletions: 0 });
    expect(files.find(file => file.path === 'deleted.txt')).toMatchObject({ status: 'deleted', deletions: 1 });
    const binary = files.find(file => file.path === 'binary.dat')!;
    expect(binary).toMatchObject({ binary: true, hunks: [] });
    expect(await service.getFileContents(repo, stash, binary, 'all')).toEqual({ oldContent: '', newContent: '' });
    expect(await service.getFileContents(repo, stash, files.find(file => file.path === 'new name.txt')!, 'all')).toMatchObject({ oldContent: 'a reusable name\n', newContent: 'a reusable name\n' });
    expect(await service.getFileContents(repo, stash, files.find(file => file.path === ':(glob)literal.ts')!, 'all')).toMatchObject({ oldContent: 'const value = 1;\n', newContent: 'const value = 2;\n' });
  });

  it('removes a stash by stable hash after indices shift and restores its durable backup', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    await writeFile(join(path, 'example.ts'), 'First experiment\n');
    await service.createStash(repo, 'First', false);
    const [first] = await service.listStashes(repo);
    await writeFile(join(path, 'example.ts'), 'Second experiment\n');
    await service.createStash(repo, 'Second', false);
    const [second] = await service.listStashes(repo);
    await writeFile(join(path, 'local-only.txt'), 'Never alter this current file.\n');
    await service.dropStash(repo, first);
    expect((await service.listStashes(repo)).map(stash => stash.hash)).toEqual([second.hash]);
    expect(git(path, 'rev-parse', `refs/stash-review/backups/${first.hash}`).trim()).toBe(first.hash);
    expect(await readFile(join(path, 'local-only.txt'), 'utf8')).toBe('Never alter this current file.\n');
    expect((await service.getDiff(repo, first, 'all', 5))[0].hunks[0].lines.some(line => line.text === 'First experiment')).toBe(true);
    await service.restoreDroppedStash(repo, first);
    await service.restoreDroppedStash(repo, first);
    expect((await service.listStashes(repo)).map(stash => stash.hash)).toEqual([first.hash, second.hash]);
    expect((await service.listStashes(repo))[0].message).toBe('First');
  });

  it('serializes concurrent removals and survives rejected operations', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    for (let index = 0; index < 3; index++) {
      await writeFile(join(path, 'example.ts'), `Experiment ${index}\n`);
      await service.createStash(repo, `Experiment ${index}`, false);
    }
    const stashes = await service.listStashes(repo);
    const anotherService = new GitService();
    await Promise.all([service.dropStash(repo, stashes[0]), anotherService.dropStash(repo, stashes[2])]);
    expect((await service.listStashes(repo)).map(stash => stash.hash)).toEqual([stashes[1].hash]);
    await expect(service.dropStash(repo, stashes[0])).rejects.toThrow('no longer on the stash list');
    expect(await service.listStashes(repo)).toHaveLength(1);
  });

  it('shares stash identity and mutation queues across linked worktrees', async () => {
    const path = await repository();
    const worktreePath = await mkdtemp(join(tmpdir(), 'stash-review-worktree-'));
    folders.push(worktreePath);
    git(path, 'worktree', 'add', '-b', 'secondary', worktreePath);
    const repo = await service.resolveRepository(path);
    const otherService = new GitService();
    const worktree = await otherService.resolveRepository(worktreePath);
    expect(worktree.id).toBe(repo.id);
    expect(worktree.path).not.toBe(repo.path);
    expect(worktree.branch).toBe('secondary');
    for (let index = 0; index < 3; index++) {
      await writeFile(join(path, 'example.ts'), `Shared experiment ${index}\n`);
      await service.createStash(repo, `Shared ${index}`, false);
    }
    const stashes = await service.listStashes(repo);
    expect((await otherService.listStashes(worktree)).map(stash => stash.hash)).toEqual(stashes.map(stash => stash.hash));
    await Promise.all([service.dropStash(repo, stashes[0]), otherService.dropStash(worktree, stashes[2])]);
    expect((await service.listStashes(repo)).map(stash => stash.hash)).toEqual([stashes[1].hash]);
    expect(await readFile(join(worktreePath, 'example.ts'), 'utf8')).toBe('const staged = 1;\nconst working = 1;\n');
  });

  it('handles duplicate reflog entries for the same immutable stash object', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    await writeFile(join(path, 'example.ts'), 'Same immutable snapshot\n');
    await service.createStash(repo, 'Duplicate', false);
    const [original] = await service.listStashes(repo);
    await writeFile(join(path, 'example.ts'), 'Other snapshot between duplicates\n');
    await service.createStash(repo, 'Other', false);
    const [other] = await service.listStashes(repo);
    git(path, 'stash', 'store', '--message', 'On main: Duplicate', original.hash);
    const duplicates = await service.listStashes(repo);
    expect(duplicates).toHaveLength(3);
    expect(duplicates[0].hash).toBe(duplicates[2].hash);
    await service.dropStash(repo, duplicates[2]);
    expect((await service.listStashes(repo)).map(stash => stash.hash)).toEqual([original.hash, other.hash]);
    await service.dropStash(repo, duplicates[0]);
    expect((await service.listStashes(repo)).map(stash => stash.hash)).toEqual([other.hash]);
    await service.restoreDroppedStash(repo, original);
    expect((await service.listStashes(repo))[0].hash).toBe(original.hash);
  });

  it('accepts repeated identical stash creation when Git reuses the same commit ID', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    await writeFile(join(path, 'example.ts'), 'Identical experiment\n');
    await service.createStash(repo, 'Identical', false);
    await writeFile(join(path, 'example.ts'), 'Identical experiment\n');
    await expect(service.createStash(repo, 'Identical', false)).resolves.toBeUndefined();
    const stashes = await service.listStashes(repo);
    expect(stashes.length).toBeGreaterThanOrEqual(1);
    expect(stashes.length).toBeLessThanOrEqual(2);
    expect(git(path, 'status', '--porcelain')).toBe('');
    expect((await service.getDiff(repo, stashes[0], 'all', 3))[0].hunks[0].lines).toContainEqual({ type: 'add', text: 'Identical experiment', newLine: 1 });
  });

  it('disables configured external diff/textconv and preserves blank context line numbers', async () => {
    const path = await repository();
    await writeFile(join(path, '.gitattributes'), '*.ts diff=unsafe\n');
    await writeFile(join(path, 'example.ts'), 'before\n\nlast\n');
    git(path, 'add', '--all');
    git(path, 'commit', '--quiet', '-m', 'Blank context');
    git(path, 'config', 'diff.external', 'false');
    git(path, 'config', 'diff.unsafe.textconv', 'false');
    git(path, 'config', 'diff.suppressBlankEmpty', 'true');
    git(path, 'config', 'core.fsmonitor', '/definitely/not-a-monitor');
    await writeFile(join(path, 'example.ts'), 'before\n\nchanged\n');
    const repo = await service.resolveRepository(path);
    await service.createStash(repo, 'Read without drivers', false);
    const [stash] = await service.listStashes(repo);
    const [file] = await service.getDiff(repo, stash, 'all', 5);
    expect(file.hunks[0].lines).toContainEqual({ type: 'context', text: '', oldLine: 2, newLine: 2 });
    expect(file.hunks[0].lines).toContainEqual({ type: 'add', text: 'changed', newLine: 3 });
  });

  it('applies to a clean working tree, restores index on request and retains the stash', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    await writeFile(join(path, 'example.ts'), 'const staged = 2;\nconst working = 1;\n');
    git(path, 'add', '--', 'example.ts');
    await writeFile(join(path, 'example.ts'), 'const staged = 2;\nconst working = 4;\n');
    await service.createStash(repo, 'Apply safely', false);
    const [stash] = await service.listStashes(repo);
    await service.applyStash(repo, stash, true);
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('const staged = 2;\nconst working = 4;\n');
    expect(git(path, 'show', ':example.ts')).toBe('const staged = 2;\nconst working = 1;\n');
    expect((await service.listStashes(repo))[0].hash).toBe(stash.hash);
  });

  it('rejects dirty applies without altering existing work and explains conflicts without dropping', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    await writeFile(join(path, 'example.ts'), 'const experimental = true;\n');
    await service.createStash(repo, 'Will conflict', false);
    const [stash] = await service.listStashes(repo);
    await writeFile(join(path, 'example.ts'), 'My current work\n');
    await expect(service.applyStash(repo, stash, false)).rejects.toThrow('working tree must be clean');
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('My current work\n');
    git(path, 'add', '--', 'example.ts');
    git(path, 'commit', '--quiet', '-m', 'Incompatible change');
    await expect(service.applyStash(repo, stash, false)).rejects.toThrow('still saved');
    expect(git(path, 'status', '--porcelain')).toContain('UU example.ts');
    expect((await service.listStashes(repo))[0].hash).toBe(stash.hash);
  });

  it('ignores inherited Git repository/index overrides and never executes stash messages', async () => {
    const path = await repository();
    const wrongPath = await repository();
    await writeFile(join(path, 'example.ts'), 'An intended change\n');
    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, {
      GIT_DIR: join(wrongPath, '.git'), GIT_WORK_TREE: wrongPath, GIT_INDEX_FILE: join(wrongPath, '.git', 'bad-index'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external', GIT_CONFIG_VALUE_0: 'exit 99'
    });
    try {
      const repo = await service.resolveRepository(path);
      expect(repo.path).toBe(await realpath(path));
      await service.createStash(repo, 'Literal $(touch should-not-exist) `echo nope`', false);
      const [stash] = await service.listStashes(repo);
      expect(stash.message).toBe('Literal $(touch should-not-exist) `echo nope`');
      expect(await service.getDiff(repo, stash, 'all', 3)).toHaveLength(1);
      expect(git(wrongPath, 'status', '--porcelain')).toBe('');
      await expect(readFile(join(path, 'should-not-exist'))).rejects.toThrow();
    } finally {
      for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  });

  it('caps full-file context without touching working files', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    await mkdir(join(path, 'notes'));
    await writeFile(join(path, 'notes', 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    await service.createStash(repo, 'Large context', true);
    const [stash] = await service.listStashes(repo);
    const [file] = await service.getDiff(repo, stash, 'all', 0);
    expect(file.path).toBe('notes/large.txt');
    expect(await service.getFileContents(repo, stash, file, 'all')).toEqual({ oldContent: '', newContent: '', truncated: true });
    expect(git(path, 'status', '--porcelain')).toBe('');
  });

  it('preserves an untracked installed plugin and its review data during vault stashing', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    const pluginFolder = '.obsidian/plugins/stash-review';
    await mkdir(join(path, pluginFolder), { recursive: true });
    await writeFile(join(path, pluginFolder, 'main.js'), 'Running plugin bundle\n');
    await writeFile(join(path, pluginFolder, 'data.json'), '{"reviews":{"saved":"annotation"}}\n');
    await writeFile(join(path, 'example.ts'), 'Tracked idea to stash\n');
    await writeFile(join(path, 'new idea.txt'), 'Untracked idea to stash\n');
    await service.createStash(repo, 'Keep the plugin running', true, [pluginFolder]);
    expect(await readFile(join(path, pluginFolder, 'main.js'), 'utf8')).toBe('Running plugin bundle\n');
    expect(await readFile(join(path, pluginFolder, 'data.json'), 'utf8')).toBe('{"reviews":{"saved":"annotation"}}\n');
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('const staged = 1;\nconst working = 1;\n');
    await expect(readFile(join(path, 'new idea.txt'))).rejects.toThrow();
    const [stash] = await service.listStashes(repo);
    expect((await service.getDiff(repo, stash, 'all', 3)).map(file => file.path)).toEqual(['example.ts', 'new idea.txt']);
  });

  it('excludes tracked plugin changes and handles protected folder names literally', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    const pluginFolder = '.obsidian/plugins/stash-review [current]';
    await mkdir(join(path, pluginFolder), { recursive: true });
    await writeFile(join(path, pluginFolder, 'data.json'), '{"version":1}\n');
    git(path, 'add', '--', pluginFolder);
    git(path, 'commit', '--quiet', '-m', 'Tracked plugin settings');
    await writeFile(join(path, pluginFolder, 'data.json'), '{"version":1,"review":"new annotation"}\n');
    await writeFile(join(path, pluginFolder, 'main.js'), 'New running bundle\n');
    await writeFile(join(path, 'example.ts'), 'New tracked experiment\n');
    await writeFile(join(path, 'loose note.md'), 'New untracked note\n');
    await service.createStash(repo, 'Only work', true, [pluginFolder]);
    expect(await readFile(join(path, pluginFolder, 'data.json'), 'utf8')).toBe('{"version":1,"review":"new annotation"}\n');
    expect(git(path, 'show', `:${pluginFolder}/data.json`)).toBe('{"version":1}\n');
    expect(await readFile(join(path, pluginFolder, 'main.js'), 'utf8')).toBe('New running bundle\n');
    const [stash] = await service.listStashes(repo);
    expect((await service.getDiff(repo, stash, 'all', 3)).map(file => file.path)).toEqual(['example.ts', 'loose note.md']);
    expect((await service.getDiff(repo, stash, 'staged', 3)).map(file => file.path)).toEqual([]);
  });

  it('rejects escaping or absolute protected paths without changing working files', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    await writeFile(join(path, 'example.ts'), 'Keep this work\n');
    for (const protectedPath of ['../elsewhere', '/absolute/folder', '.', 'bad\0folder']) {
      await expect(service.createStash(repo, 'Invalid exclusion', true, [protectedPath])).rejects.toThrow('Invalid file path');
    }
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('Keep this work\n');
    expect(await service.listStashes(repo)).toEqual([]);
  });

  it('refuses staged protected plugin data before touching the index, worktree, or stash list', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    const pluginFolder = '.obsidian/plugins/stash-review';
    await mkdir(join(path, pluginFolder), { recursive: true });
    await writeFile(join(path, pluginFolder, 'data.json'), '{"version":1}\n');
    git(path, 'add', '--all');
    git(path, 'commit', '--quiet', '-m', 'Tracked plugin settings');
    await writeFile(join(path, pluginFolder, 'data.json'), '{"version":1,"review":"staged annotation"}\n');
    git(path, 'add', '--', `${pluginFolder}/data.json`);
    await writeFile(join(path, pluginFolder, 'data.json'), '{"version":1,"review":"later annotation"}\n');
    await writeFile(join(path, 'example.ts'), 'Current work to keep\n');
    await writeFile(join(path, 'untracked idea.md'), 'Untracked work to keep\n');
    const beforeStatus = git(path, 'status', '--porcelain=v1', '-z');
    const beforeIndex = git(path, 'write-tree').trim();
    await expect(service.createStash(repo, 'Must not mutate', true, [pluginFolder])).rejects.toThrow('Unstage Stash Review plugin files');
    expect(git(path, 'status', '--porcelain=v1', '-z')).toBe(beforeStatus);
    expect(git(path, 'write-tree').trim()).toBe(beforeIndex);
    expect(await readFile(join(path, pluginFolder, 'data.json'), 'utf8')).toBe('{"version":1,"review":"later annotation"}\n');
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('Current work to keep\n');
    expect(await readFile(join(path, 'untracked idea.md'), 'utf8')).toBe('Untracked work to keep\n');
    expect(await service.listStashes(repo)).toEqual([]);
  });

  it('applies clean user work while leaving untracked plugin runtime files and reviews untouched', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    const pluginFolder = '.obsidian/plugins/stash-review';
    await writeFile(join(path, 'example.ts'), 'Saved user experiment\n');
    await service.createStash(repo, 'Apply with active plugin', false);
    const [stash] = await service.listStashes(repo);
    await mkdir(join(path, pluginFolder), { recursive: true });
    await writeFile(join(path, pluginFolder, 'main.js'), 'Running plugin bundle\n');
    await writeFile(join(path, pluginFolder, 'data.json'), '{"review":"new local annotation"}\n');
    await service.applyStash(repo, stash, false, [pluginFolder]);
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('Saved user experiment\n');
    expect(await readFile(join(path, pluginFolder, 'main.js'), 'utf8')).toBe('Running plugin bundle\n');
    expect(await readFile(join(path, pluginFolder, 'data.json'), 'utf8')).toBe('{"review":"new local annotation"}\n');
    expect((await service.listStashes(repo))[0].hash).toBe(stash.hash);
  });

  it('restores the saved user index while preserving unstaged plugin metadata', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    const pluginFolder = '.obsidian/plugins/stash-review';
    await mkdir(join(path, pluginFolder), { recursive: true });
    await writeFile(join(path, pluginFolder, 'data.json'), '{"review":"baseline"}\n');
    git(path, 'add', '--all');
    git(path, 'commit', '--quiet', '-m', 'Tracked review metadata');
    await writeFile(join(path, 'example.ts'), 'Saved staged user code\n');
    git(path, 'add', '--', 'example.ts');
    await writeFile(join(path, 'example.ts'), 'Saved unstaged user code\n');
    await service.createStash(repo, 'Restore only user index', false, [pluginFolder]);
    const [stash] = await service.listStashes(repo);
    await writeFile(join(path, pluginFolder, 'data.json'), '{"review":"latest local annotation"}\n');
    await service.applyStash(repo, stash, true, [pluginFolder]);
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('Saved unstaged user code\n');
    expect(git(path, 'show', ':example.ts')).toBe('Saved staged user code\n');
    expect(await readFile(join(path, pluginFolder, 'data.json'), 'utf8')).toBe('{"review":"latest local annotation"}\n');
    expect(git(path, 'show', `:${pluginFolder}/data.json`)).toBe('{"review":"baseline"}\n');
    expect((await service.listStashes(repo))[0].hash).toBe(stash.hash);
  });

  it.each([false, true])('refuses staged plugin metadata without changing the index or worktree (restoreIndex=%s)', async (restoreIndex) => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    const pluginFolder = '.obsidian/plugins/stash-review';
    await mkdir(join(path, pluginFolder), { recursive: true });
    await writeFile(join(path, pluginFolder, 'data.json'), '{"review":"baseline"}\n');
    git(path, 'add', '--all');
    git(path, 'commit', '--quiet', '-m', 'Tracked plugin metadata');
    await writeFile(join(path, 'example.ts'), 'User code to apply\n');
    git(path, 'add', '--', 'example.ts');
    await service.createStash(repo, 'User staged code', false, [pluginFolder]);
    const [stash] = await service.listStashes(repo);
    await writeFile(join(path, pluginFolder, 'data.json'), '{"review":"staged local annotation"}\n');
    git(path, 'add', '--', `${pluginFolder}/data.json`);
    await writeFile(join(path, pluginFolder, 'data.json'), '{"review":"latest local annotation"}\n');
    const beforeStatus = git(path, 'status', '--porcelain=v1', '-z');
    const beforeIndex = git(path, 'write-tree').trim();
    await expect(service.applyStash(repo, stash, restoreIndex, [pluginFolder])).rejects.toThrow('Unstage Stash Review plugin files before applying a stash');
    expect(git(path, 'status', '--porcelain=v1', '-z')).toBe(beforeStatus);
    expect(git(path, 'write-tree').trim()).toBe(beforeIndex);
    expect(await readFile(join(path, pluginFolder, 'data.json'), 'utf8')).toBe('{"review":"latest local annotation"}\n');
    expect(git(path, 'show', `:${pluginFolder}/data.json`)).toBe('{"review":"staged local annotation"}\n');
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('const staged = 1;\nconst working = 1;\n');
    expect((await service.listStashes(repo))[0].hash).toBe(stash.hash);
  });

  it('still blocks unrelated dirty user files when plugin runtime changes are protected', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    const pluginFolder = '.obsidian/plugins/stash-review';
    await writeFile(join(path, 'example.ts'), 'Saved experiment\n');
    await service.createStash(repo, 'Keep user work safe', false);
    const [stash] = await service.listStashes(repo);
    await mkdir(join(path, pluginFolder), { recursive: true });
    await writeFile(join(path, pluginFolder, 'data.json'), '{"review":"local"}\n');
    await writeFile(join(path, 'unrelated.md'), 'Current user idea\n');
    await expect(service.applyStash(repo, stash, false, [pluginFolder])).rejects.toThrow('working tree must be clean');
    expect(await readFile(join(path, 'unrelated.md'), 'utf8')).toBe('Current user idea\n');
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('const staged = 1;\nconst working = 1;\n');
    expect(await readFile(join(path, pluginFolder, 'data.json'), 'utf8')).toBe('{"review":"local"}\n');
  });

  it.each(['tracked', 'untracked', 'staged-only'] as const)('refuses a stash containing %s protected plugin changes before applying anything', async (kind) => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    const pluginFolder = '.obsidian/plugins/stash-review [current]';
    await mkdir(join(path, pluginFolder), { recursive: true });
    const baseline = '{"review":"baseline"}\n';
    if (kind !== 'untracked') {
      await writeFile(join(path, pluginFolder, 'data.json'), baseline);
      git(path, 'add', '--all');
      git(path, 'commit', '--quiet', '-m', 'Plugin baseline');
    }
    await writeFile(join(path, pluginFolder, 'data.json'), '{"review":"older stashed annotation"}\n');
    if (kind === 'staged-only') {
      git(path, 'add', '--', `${pluginFolder}/data.json`);
      await writeFile(join(path, pluginFolder, 'data.json'), baseline);
    }
    await writeFile(join(path, 'example.ts'), 'User code alongside plugin snapshot\n');
    await service.createStash(repo, `Unsafe ${kind} plugin snapshot`, kind === 'untracked');
    const [stash] = await service.listStashes(repo);
    if (kind === 'untracked') await mkdir(join(path, pluginFolder), { recursive: true });
    await writeFile(join(path, pluginFolder, 'data.json'), '{"review":"latest local annotation"}\n');
    const beforeStatus = git(path, 'status', '--porcelain=v1', '-z');
    const beforeIndex = git(path, 'write-tree').trim();
    await expect(service.applyStash(repo, stash, true, [pluginFolder])).rejects.toThrow('This stash changes Stash Review plugin files');
    expect(git(path, 'status', '--porcelain=v1', '-z')).toBe(beforeStatus);
    expect(git(path, 'write-tree').trim()).toBe(beforeIndex);
    expect(await readFile(join(path, pluginFolder, 'data.json'), 'utf8')).toBe('{"review":"latest local annotation"}\n');
    expect(await readFile(join(path, 'example.ts'), 'utf8')).toBe('const staged = 1;\nconst working = 1;\n');
    expect((await service.listStashes(repo))[0].hash).toBe(stash.hash);
  });

  it('supports SHA-256 stash objects including the untracked third parent', async () => {
    const path = await repository(true);
    const repo = await service.resolveRepository(path);
    await writeFile(join(path, 'untracked.ts'), 'export const untracked = true;\n');
    await service.createStash(repo, 'SHA-256', true);
    const [stash] = await service.listStashes(repo);
    expect(stash.hash).toHaveLength(64);
    const [file] = await service.getDiff(repo, stash, 'all', 3);
    expect(file).toMatchObject({ path: 'untracked.ts', untracked: true, status: 'added' });
    expect(await service.getFileContents(repo, stash, file, 'all')).toMatchObject({ newContent: 'export const untracked = true;\n' });
  });

  it('rejects malformed identifiers/context and reports no-op stash creation', async () => {
    const path = await repository();
    const repo = await service.resolveRepository(path);
    await expect(service.createStash(repo, 'Empty', false)).rejects.toThrow('Nothing to stash');
    const fake = { hash: '--help', ref: 'stash@{0}', message: '', branch: 'main', createdAt: '', baseHash: '' };
    await expect(service.getDiff(repo, fake, 'all', 3)).rejects.toThrow('Invalid stash commit ID');
    await expect(service.getDiff(repo, fake, 'all', 1000)).rejects.toThrow('between 0 and 500');
    await expect(new GitService('/definitely/missing/git').resolveRepository(path)).rejects.toThrow('Git was not found');
  });
});
