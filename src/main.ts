import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { FileSystemAdapter, ItemView, Notice, Plugin, PluginSettingTab, Setting, type App, type WorkspaceLeaf } from 'obsidian';
import { GitService } from './git';
import { loadPluginData, readMetadata, reviewMarkdown } from './review-store';
import { ReviewApp } from './ui/ReviewApp';
import { type PluginData, type Repository, type ReviewHost, type Stash, type StashMetadata } from './types';

const VIEW_TYPE = 'stash-review';

export default class StashReviewPlugin extends Plugin {
  data: PluginData = loadPluginData(null);
  git!: GitService;
  private pendingSave: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    this.data = loadPluginData(await this.loadData());
    this.git = new GitService(this.data.settings.gitPath);
    this.registerView(VIEW_TYPE, leaf => new StashReviewView(leaf, this));
    this.addRibbonIcon('git-pull-request', 'Open Stash Review', () => { void this.openReview(); });
    this.addCommand({ id: 'open-review', name: 'Open stash review', callback: () => this.openReview() });
    this.addSettingTab(new StashReviewSettings(this.app, this));
  }

  async persist(): Promise<void> {
    const save = this.pendingSave.catch(() => {}).then(() => this.saveData(this.data));
    this.pendingSave = save;
    await save;
  }

  async openReview(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async listRepositories(): Promise<Repository[]> {
    let paths = this.data.settings.repositories;
    if (!paths.length && this.app.vault.adapter instanceof FileSystemAdapter) paths = [this.app.vault.adapter.getBasePath()];
    const results = await Promise.allSettled(paths.map(path => this.git.resolveRepository(path)));
    const repositories = results.filter((r): r is PromiseFulfilledResult<Repository> => r.status === 'fulfilled').map(r => r.value);
    const unique = repositories.filter((repository, index) => repositories.findIndex(r => r.path === repository.path) === index);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length && this.data.settings.repositories.length) new Notice(`Stash Review: ${failures.length} configured repository path(s) could not be opened. Check the paths in settings.`);
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
    return path ? [path.split(sep).join('/')] : ['main.js', 'manifest.json', 'styles.css', 'data.json'];
  }

  createHost(): ReviewHost {
    const plugin = this;
    return {
      get settings() { return plugin.data.settings; },
      listRepositories: () => plugin.listRepositories(),
      async addRepository(path) {
        const repository = await plugin.git.resolveRepository(path);
        if (!plugin.data.settings.repositories.includes(repository.path)) {
          plugin.data.settings.repositories.push(repository.path);
          await plugin.persist();
        }
        return repository;
      },
      listStashes: repository => plugin.git.listStashes(repository),
      getDiff: (repository, stash, layer, context) => plugin.git.getDiff(repository, stash, layer, context),
      getFileContents: (repository, stash, file, layer) => plugin.git.getFileContents(repository, stash, file, layer),
      getMetadata: (repositoryId, hash) => readMetadata(plugin.data, repositoryId, hash),
      async saveMetadata(repositoryId, hash, metadata) {
        if (!Object.hasOwn(plugin.data.reviews, repositoryId)) plugin.data.reviews[repositoryId] = {};
        plugin.data.reviews[repositoryId][hash] = structuredClone(metadata);
        await plugin.persist();
      },
      async createStash(repository, message, untracked) {
        await plugin.git.createStash(repository, message, untracked, await plugin.protectedPluginPaths(repository));
      },
      async applyStash(repository, stash, index) {
        await plugin.git.applyStash(repository, stash, index, await plugin.protectedPluginPaths(repository));
      },
      dropStash: (repository, stash) => plugin.git.dropStash(repository, stash),
      restoreDroppedStash: (repository, stash) => plugin.git.restoreDroppedStash(repository, stash),
      async exportReview(repository, stash, metadata) {
        const folder = 'Stash Reviews';
        if (!(await plugin.app.vault.adapter.exists(folder))) {
          try { await plugin.app.vault.createFolder(folder); }
          catch (error) { if (!(await plugin.app.vault.adapter.exists(folder))) throw error; }
        }
        const title = (metadata.title || stash.message).replace(/[^\p{L}\p{N}\- _]/gu, '').trim().slice(0, 70) || 'Stash';
        const path = `${folder}/${title} ${stash.hash.slice(0, 8)} ${Date.now()}.md`;
        const note = await plugin.app.vault.create(path, reviewMarkdown(repository, stash, metadata));
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
  constructor(leaf: WorkspaceLeaf, private plugin: StashReviewPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Stash Review'; }
  getIcon(): string { return 'git-pull-request'; }
  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('stash-review-view');
    this.root = createRoot(this.contentEl);
    this.root.render(createElement(ReviewApp, { host: this.plugin.createHost() }));
  }
  async onClose(): Promise<void> {
    this.root?.unmount();
    this.contentEl.empty();
    this.contentEl.removeClass('stash-review-view');
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
    try { await this.plugin.persist(); }
    catch (error) { new Notice(`Could not save Stash Review settings: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
