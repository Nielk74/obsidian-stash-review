// Execute the exact release bundle through Obsidian's CommonJS plugin contract.
// This validates packaging and host integration; browser tests cover the rendered UI.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const bundleRoot = process.env.STASH_REVIEW_BUNDLE_DIR ? resolve(process.env.STASH_REVIEW_BUNDLE_DIR) : root;
const require = createRequire(import.meta.url);
const source = await readFile(join(bundleRoot, 'main.js'), 'utf8');
const manifest = JSON.parse(await readFile(join(bundleRoot, 'manifest.json'), 'utf8'));
const notices = [];
class Plugin {
  constructor(app) { this.app = app; this.manifest = manifest; this.saved = []; this.commands = []; }
  async loadData() { return null; }
  async saveData(data) { this.saved.push(structuredClone(data)); }
  registerView(type, factory) { this.registeredView = { type, factory }; }
  addRibbonIcon(icon, title, callback) { this.ribbon = { icon, title, callback }; }
  addCommand(command) { this.commands.push(command); }
  addSettingTab(tab) { this.tab = tab; }
}
class FileSystemAdapter { constructor(path) { this.path = path; } getBasePath() { return this.path; } }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class ItemView {}
class Setting {}
class Notice { constructor(message) { notices.push(message); } }
const obsidian = { Plugin, FileSystemAdapter, PluginSettingTab, ItemView, Setting, Notice };
const mod = { exports: {} };
const wrapper = vm.runInThisContext(`(function(exports, require, module, __filename, __dirname) {\n${source}\n})`, { filename: 'stash-review-release.js' });
wrapper(mod.exports, name => name === 'obsidian' ? obsidian : require(name), mod, join(bundleRoot, 'main.js'), bundleRoot);
assert.equal(typeof mod.exports.default, 'function', 'Release bundle must export a default plugin class');
const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'stash-review-package-')));
try {
  const notes = new Map();
  const app = {
    vault: {
      adapter: new FileSystemAdapter(sandbox),
      async createFolder(path) { notes.set(path, { path }); },
      async create(path, body) { const note = { path, body }; notes.set(path, note); return note; }
    },
    workspace: {
      getLeavesOfType() { return []; },
      getLeaf() { return { async setViewState(state) { app.lastState = state; }, async openFile(file) { app.lastFile = file; } }; },
      async revealLeaf(leaf) { app.lastLeaf = leaf; }
    }
  };
  app.vault.adapter.exists = async path => notes.has(path);
  const plugin = new mod.exports.default(app);
  await plugin.onload();
  assert.equal(plugin.registeredView.type, 'stash-review');
  assert.equal(plugin.ribbon.icon, 'git-pull-request');
  await plugin.commands.find(c => c.id === 'open-review').callback();
  assert.equal(app.lastState.type, 'stash-review');
  const host = plugin.createHost();
  const metadata = { title: 'Review prototype', description: 'Remember this idea', tags: ['idea'], pinned: true, reviewedFiles: ['app.ts'], annotations: [] };
  await Promise.all([
    host.saveMetadata('repoA', 'a'.repeat(40), metadata),
    host.saveMetadata('repoB', 'b'.repeat(40), { ...metadata, title: 'Different repository' })
  ]);
  assert.equal(plugin.saved.at(-1).reviews.repoA['a'.repeat(40)].title, metadata.title);
  assert.equal(plugin.saved.at(-1).reviews.repoB['b'.repeat(40)].title, 'Different repository');
  const loaded = host.getMetadata('repoA', 'a'.repeat(40));
  loaded.tags.push('local mutation');
  assert.deepEqual(host.getMetadata('repoA', 'a'.repeat(40)).tags, ['idea']);
  const repository = { id: 'repoA', name: 'Fixture', path: sandbox, branch: 'main', dirty: false };
  const stash = { hash: 'a'.repeat(40), ref: 'stash@{0}', message: 'Prototype', branch: 'main', createdAt: new Date().toISOString(), baseHash: 'b'.repeat(40) };
  let capture;
  plugin.git.createStash = async (...args) => { capture = args; };
  await host.createStash(repository, 'Preserve reviews', true);
  assert.deepEqual(capture[3], ['.obsidian/plugins/stash-review'], 'Stashing the vault must preserve the running plugin directory');
  await host.createStash({ ...repository, path: join(sandbox, 'other-repository') }, 'External work', true);
  assert.deepEqual(capture[3], [], 'External repositories must not receive vault path exclusions');
  plugin.git.applyStash = async (...args) => { capture = args; };
  await host.applyStash(repository, stash, false);
  assert.deepEqual(capture[3], ['.obsidian/plugins/stash-review'], 'Applying in the vault must protect review data');
  const exported = await host.exportReview(repository, stash, metadata);
  assert.ok(exported.startsWith('Stash Reviews/'));
  assert.ok(notes.get(exported).body.includes('Remember this idea'));
  assert.equal(app.lastFile.path, exported);
  console.log('Release bundle passed: CommonJS loading, commands, view registration, serialized persistence, isolated metadata, self-file protection and vault export.');
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
