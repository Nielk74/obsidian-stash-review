import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {gzip, gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import { Component, FileSystemAdapter, ItemView, MarkdownRenderer, MarkdownRenderChild, Notice, Plugin, PluginSettingTab, Setting, type App, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { GitService } from './git';
import { loadPluginData, readMetadata, reviewMarkdown, reviewSummary } from './review-store';
import { ReviewApp } from './ui/ReviewApp';
import {parseReviewBlock, parseReviewParameters} from './markdown';
import {ReadCache} from './read-cache';
import {MAX_PACKAGE_BYTES, parseSavedLayer, validRepositoryId} from './review-portability';
import {DataTransactions, ReviewLibrary, type SnapshotStorage} from './review-library';
import { type DiffFile, type PluginData, type Repository, type ReviewHost, type ReviewTarget } from './types';

const VIEW_TYPE = 'stash-review';
const compressSnapshot = promisify(gzip), decompressSnapshot = promisify(gunzip);

export function createSnapshotStorage(directory: string): SnapshotStorage {
  const filename = (id: string, hash: string, layer: string): string => {
    if (!validRepositoryId(id) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash) || !['all','staged','unstaged'].includes(layer)) throw new Error('Invalid review repository or stash identity.');
    return join(directory,createHash('sha256').update(id).digest('hex'),hash,`${layer}.json.gz`);
  };
  return {
    async read(id,hash,layer) {
      const path = filename(id,hash,layer);
      try {
        if ((await stat(path)).size > MAX_PACKAGE_BYTES + 1024 * 1024) throw new Error('Saved review snapshot exceeds the size limit.');
        const source = await decompressSnapshot(await readFile(path),{maxOutputLength:MAX_PACKAGE_BYTES});
        return parseSavedLayer(JSON.parse(source.toString('utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new Error(`The saved review snapshot could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async write(id,hash,layer,snapshot) {
      const path = filename(id,hash,layer);
      const source = Buffer.from(JSON.stringify(parseSavedLayer(snapshot)),'utf8');
      if (source.length > MAX_PACKAGE_BYTES) throw new Error('The saved review snapshot exceeds the 32 MiB size limit.');
      const compressed = await compressSnapshot(source);
      await mkdir(dirname(path),{recursive:true});
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {await writeFile(temporary,compressed); await rename(temporary,path);}
      finally {await unlink(temporary).catch(() => {});}
    }
  };
}

export default class StashReviewPlugin extends Plugin {
  data: PluginData = loadPluginData(null);
  git!: GitService;
  private writes!: DataTransactions;
  private library!: ReviewLibrary;
  private host?: ReviewHost;
  private reads = new ReadCache(16 * 1024 * 1024, 32);
  private metadataListeners = new Set<(repositoryId: string, hash: string) => void>();
  readonly embeds = new Set<StashReviewEmbed>();

  async onload(): Promise<void> {
    this.data = loadPluginData(await this.loadData());
    this.git = new GitService(this.data.settings.gitPath);
    this.writes = new DataTransactions(() => this.data, data => {
      const previous = this.data; this.data = data;
      for (const [id,reviews] of Object.entries(data.reviews)) for (const [hash,metadata] of Object.entries(reviews)) {
        if (JSON.stringify(previous.reviews[id]?.[hash]) !== JSON.stringify(metadata)) this.metadataListeners.forEach(listener => listener(id,hash));
      }
    }, data => this.saveData(data));
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('Stash Review requires a local filesystem vault.');
    const directory = join(adapter.getBasePath(),this.app.vault.configDir || '.obsidian','plugins',this.manifest.id,'reviews');
    this.library = new ReviewLibrary({getData:() => this.data,transaction:change => this.writes.transaction(change),storage:createSnapshotStorage(directory),warn:message => new Notice(message)},() => this.git,this.reads);
    this.registerView(VIEW_TYPE, leaf => new StashReviewView(leaf, this));
    this.registerObsidianProtocolHandler(VIEW_TYPE, async parameters => {
      try {await this.openReview(parseReviewParameters(parameters));}
      catch (error) {new Notice(`Stash Review: ${error instanceof Error ? error.message : String(error)}`);}
    });
    this.registerMarkdownCodeBlockProcessor(VIEW_TYPE, (source, el, context) => {
      if (el.closest?.('.sr-markdown')) {el.textContent = source; return;}
      try {context.addChild(new StashReviewEmbed(el, this, parseReviewBlock(source)));}
      catch (error) {
        el.empty(); el.addClass('sr-embed-error');
        el.createEl('strong', {text: 'Cannot display this stash review'});
        el.createEl('p', {text: error instanceof Error ? error.message : String(error)});
      }
    });
    this.addRibbonIcon('git-pull-request', 'Open Stash Review', () => { void this.openReview(); });
    this.addCommand({ id: 'open-review', name: 'Open stash review', callback: () => this.openReview() });
    this.addSettingTab(new StashReviewSettings(this.app, this));
  }

  onunload(): void {
    for (const embed of this.embeds) embed.unload();
    this.metadataListeners.clear();
    this.reads.clear();
  }

  async persist(): Promise<void> {
    await this.writes.persist();
  }

  async openReview(target?: ReviewTarget): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing || target) await leaf.setViewState({ type: VIEW_TYPE, active: true, ...(target ? {state: {repo: target.repositoryId, stash: target.stashHash, layer: target.layer ?? 'all', ...(target.file ? {file: target.file} : {})}} : {}) });
    await this.app.workspace.revealLeaf(leaf);
  }

  async listRepositories(): Promise<Repository[]> {
    let paths = this.data.settings.repositories;
    if (!paths.length && this.app.vault.adapter instanceof FileSystemAdapter) paths = [this.app.vault.adapter.getBasePath()];
    const results = await Promise.allSettled(paths.map(async path => this.library.registerRepository(await this.git.resolveRepository(path),path)));
    const repositories = results.filter((r): r is PromiseFulfilledResult<Repository> => r.status === 'fulfilled').map(r => r.value);
    const unique = repositories.filter((repository, index) => repositories.findIndex(r => r.path === repository.path) === index);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length && this.data.settings.repositories.length) new Notice(`Stash Review: ${failures.length} configured repository path(s) could not be opened. Check the paths in settings.`);
    for (const binding of Object.values(this.data.repositoryCatalog ?? {})) if (!unique.some(repo => repo.id === binding.id)) {
      unique.push({id:binding.id,name:binding.name,path:`library://${binding.id}`,branch:'',dirty:false,offline:true});
    }
    return unique;
  }

  private async protectedPluginPaths(repository: Repository): Promise<string[]> {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return [];
    const vaultRoot = await realpath(this.app.vault.adapter.getBasePath());
    const pluginDirectory = join(vaultRoot, this.app.vault.configDir || '.obsidian', 'plugins', this.manifest.id);
    const path = relative(repository.path, pluginDirectory);
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return [];
    // Keep the running plugin and local review data available when stashing the vault.
    // If this plugin's own source folder is the repository, protect only runtime files.
    return path ? [path.split(sep).join('/')] : ['main.js', 'manifest.json', 'styles.css', 'data.json', 'reviews'];
  }

  createHost(): ReviewHost {
    if (this.host) return this.host;
    const plugin = this;
    return this.host = {
      get settings() { return plugin.data.settings; },
      vaultName: plugin.app.vault.getName(),
      openReview: target => plugin.openReview(target),
      subscribeMetadata(listener) {
        plugin.metadataListeners.add(listener);
        return () => {plugin.metadataListeners.delete(listener);};
      },
      listRepositories: () => plugin.reads.read(JSON.stringify(['repositories', plugin.data.settings.gitPath, plugin.data.settings.repositories]), () => plugin.listRepositories()),
      async addRepository(path) {
        const repository = await plugin.library.registerRepository(await plugin.git.resolveRepository(path),path);
        if (!plugin.data.settings.repositories.includes(repository.path)) {
          plugin.data.settings.repositories.push(repository.path);
          await plugin.persist();
        }
        return repository;
      },
      listStashes: repository => plugin.reads.read(JSON.stringify(['stashes', repository.id, repository.path]), () => plugin.library.listActiveStashes(repository)),
      listArchivedReviews: repository => plugin.reads.read(JSON.stringify(['archives',repository.id,repository.path]),() => plugin.library.listArchivedReviews(repository)),
      getDiff: (repository,stash,layer,context) => plugin.library.getDiff(repository,stash,layer,context),
      getFileContents: (repository,stash,file,layer) => plugin.library.getFileContents(repository,stash,file,layer),
      archiveReview: (repository,stash,archived) => plugin.library.archiveReview(repository,stash,archived),
      continueReview: (repository,stash,hash) => plugin.library.continueReview(repository,stash,hash),
      relocateRepository: (id,path) => plugin.library.relocateRepository(id,path),
      exportReviewData: (repository,stash) => plugin.library.exportReviewData(repository,stash),
      importReviewData: (source,id) => plugin.library.importReviewData(source,id),
      invalidateReads: () => plugin.library.clear(),
      renderMarkdown(source,element) {
        const child = new Component(), rendered = element.ownerDocument.createElement('div');
        element.append(rendered); plugin.addChild(child);
        let disposed = false;
        void MarkdownRenderer.render(plugin.app,source,rendered,'',child).catch(() => {if (!disposed) rendered.textContent = source;});
        return () => {if (disposed) return; disposed = true; plugin.removeChild(child); rendered.remove();};
      },
      getMetadata: (repositoryId, hash) => readMetadata(plugin.data, repositoryId, hash),
      getReviewSummary: (id,hash) => reviewSummary(plugin.data,id,hash),
      updateMetadata(repositoryId, hash, change) {
        const metadata = change(readMetadata(plugin.data, repositoryId, hash));
        return {metadata, saved: this.saveMetadata(repositoryId, hash, metadata)};
      },
      async saveMetadata(repositoryId, hash, metadata) {
        const saved = plugin.writes.saveMetadata(repositoryId,hash,metadata);
        for (const listener of plugin.metadataListeners) listener(repositoryId, hash);
        await saved;
      },
      async createStash(repository, message, untracked) {
        if (repository.offline) throw new Error('Connect the repository before creating a stash.');
        await plugin.git.createStash(repository, message, untracked, await plugin.protectedPluginPaths(repository));
      },
      async applyStash(repository, stash, index) {
        if (repository.offline) throw new Error('Connect the repository before applying a stash.');
        await plugin.git.applyStash(repository, stash, index, await plugin.protectedPluginPaths(repository));
      },
      dropStash: (repository, stash) => repository.offline ? Promise.reject(new Error('Connect the repository before dropping a stash.')) : plugin.git.dropStash(repository, stash),
      restoreDroppedStash: (repository, stash) => repository.offline ? Promise.reject(new Error('Connect the repository before restoring a stash.')) : plugin.git.restoreDroppedStash(repository, stash),
      async exportReview(repository, stash, metadata) {
        metadata = await plugin.library.withExcerpts(repository,stash,metadata);
        const folder = 'Stash Reviews';
        if (!(await plugin.app.vault.adapter.exists(folder))) {
          try { await plugin.app.vault.createFolder(folder); }
          catch (error) { if (!(await plugin.app.vault.adapter.exists(folder))) throw error; }
        }
        const title = (metadata.title || stash.message).replace(/[^\p{L}\p{N}\- _]/gu, '').trim().slice(0, 70) || 'Stash';
        const path = `${folder}/${title} ${stash.hash.slice(0, 8)} ${Date.now()}.md`;
        const note = await plugin.app.vault.create(path, reviewMarkdown(repository, stash, metadata, plugin.app.vault.getName()));
        await plugin.app.workspace.getLeaf('tab').openFile(note);
        return path;
      },
      notify: message => { new Notice(message); },
      openSettings() {
        // Obsidian currently exposes opening an individual settings tab through this runtime API.
        const settings = (plugin.app as App & { setting?: { open(): void; openTabById(id: string): void } }).setting;
        if (settings) { settings.open(); settings.openTabById(plugin.manifest.id); }
        else new Notice('Open Settings → Stash Review to configure repositories.');
      }
    };
  }
}

class StashReviewView extends ItemView {
  private root?: Root;
  private target?: ReviewTarget;
  constructor(leaf: WorkspaceLeaf, private plugin: StashReviewPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Stash Review'; }
  getIcon(): string { return 'git-pull-request'; }
  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('stash-review-view');
    this.root = createRoot(this.contentEl);
    this.render();
  }
  getState(): Record<string, unknown> {
    return this.target ? {repo: this.target.repositoryId, stash: this.target.stashHash, layer: this.target.layer ?? 'all', ...(this.target.file ? {file: this.target.file} : {})} : {};
  }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.target = state && typeof state === 'object' && ('repo' in state || 'stash' in state) ? parseReviewParameters(state as Record<string, unknown>) : undefined;
    await super.setState(state, result);
    this.render();
  }
  private render(): void {
    this.root?.render(createElement(ReviewApp, {host: this.plugin.createHost(), target: this.target}));
  }
  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = undefined;
    this.contentEl.empty();
    this.contentEl.removeClass('stash-review-view');
  }
}

class StashReviewEmbed extends MarkdownRenderChild {
  private root?: Root;
  constructor(el: HTMLElement, private plugin: StashReviewPlugin, private target: ReviewTarget) {super(el);}
  onload(): void {
    this.containerEl.empty(); this.containerEl.addClass('stash-review-embed');
    this.plugin.embeds.add(this);
    this.root = createRoot(this.containerEl);
    this.root.render(createElement(ReviewApp, {host: this.plugin.createHost(), target: this.target, embedded: true}));
  }
  onunload(): void {
    this.root?.unmount(); this.root = undefined;
    this.plugin.embeds.delete(this);
    this.containerEl.empty(); this.containerEl.removeClass('stash-review-embed');
  }
}

class StashReviewSettings extends PluginSettingTab {
  constructor(app: App, private plugin: StashReviewPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('Stash Review').setHeading();
    containerEl.createEl('p', { text: 'Review stashes from your vault or any local Git repository. Code and annotations stay on this computer.' });
    new Setting(containerEl)
      .setName('Repositories')
      .setDesc('Absolute folder paths, one per line. Leave empty to use the current vault. You can also add a repository in the review view.')
      .addTextArea(text => text.setPlaceholder('/path/to/project').setValue(this.plugin.data.settings.repositories.join('\n')).onChange(async value => {
        this.plugin.data.settings.repositories = [...new Set(value.split('\n').map(path => path.trim()).filter(Boolean))];
        await this.save();
      }));
    for (const binding of Object.values(this.plugin.data.repositoryCatalog ?? {})) {
      let newPath = binding.paths[0] ?? '';
      new Setting(containerEl).setName(`Relocate ${binding.name}`).setDesc('Choose its new folder while keeping saved notes and review links.')
        .addText(text => text.setValue(newPath).onChange(value => {newPath=value;}))
        .addButton(button => button.setButtonText('Relocate').onClick(async () => {
          button.setDisabled(true);
          try {await this.plugin.createHost().relocateRepository!(binding.id,newPath.trim());new Notice(`Moved the review binding for ${binding.name}.`);this.display();}
          catch (error) {new Notice(`Could not relocate repository: ${error instanceof Error ? error.message : String(error)}`);}
          finally {button.setDisabled(false);}
        }));
    }
    new Setting(containerEl)
      .setName('Git executable')
      .setDesc('Use git from PATH, or an absolute executable path if Obsidian cannot find it (for example /opt/homebrew/bin/git). Restart the review tab after changing this.')
      .addText(text => text.setValue(this.plugin.data.settings.gitPath).onChange(async value => {
        this.plugin.data.settings.gitPath = value.trim() || 'git';
        this.plugin.git = new GitService(this.plugin.data.settings.gitPath);
        await this.save();
      }));
    new Setting(containerEl).setName('Default diff layout').addDropdown(dropdown => dropdown.addOption('unified', 'Unified').addOption('split', 'Side by side').setValue(this.plugin.data.settings.defaultView).onChange(async value => {
      this.plugin.data.settings.defaultView = value === 'split' ? 'split' : 'unified';
      await this.save();
    }));
    new Setting(containerEl).setName('Context lines').setDesc('Unchanged lines shown around each change. Full-file context is available in the review view.').addDropdown(dropdown => {
      for (const count of [3, 5, 10, 20]) dropdown.addOption(String(count), String(count));
      dropdown.setValue(String(this.plugin.data.settings.contextLines)).onChange(async value => {
        this.plugin.data.settings.contextLines = Number(value);
        await this.save();
      });
    });
    new Setting(containerEl).setName('Refresh interval').setDesc('Automatically check for new stashes. Set to 0 to refresh manually.').addDropdown(dropdown => {
      for (const seconds of [0, 15, 30, 60, 120]) dropdown.addOption(String(seconds), seconds ? `${seconds} seconds` : 'Manual');
      dropdown.setValue(String(this.plugin.data.settings.refreshInterval)).onChange(async value => {
        this.plugin.data.settings.refreshInterval = Number(value);
        await this.save();
      });
    });
    new Setting(containerEl).setName('Open review workspace').addButton(button => button.setButtonText('Open Stash Review').setCta().onClick(() => this.plugin.openReview()));
  }
  private async save(): Promise<void> {
    this.plugin.createHost().invalidateReads?.();
    try { await this.plugin.persist(); }
    catch (error) { new Notice(`Could not save Stash Review settings: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
