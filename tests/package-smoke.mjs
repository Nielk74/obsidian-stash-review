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
  constructor(app) { this.app = app; this.manifest = manifest; this.saved = []; this.commands = []; this.protocols = new Map(); this.blocks = new Map(); }
  async loadData() { return null; }
  async saveData(data) { this.saved.push(structuredClone(data)); }
  registerView(type, factory) { this.registeredView = { type, factory }; }
  registerObsidianProtocolHandler(action, handler) { this.protocols.set(action, handler); }
  registerMarkdownCodeBlockProcessor(language, handler) { this.blocks.set(language, handler); }
  addRibbonIcon(icon, title, callback) { this.ribbon = { icon, title, callback }; }
  addCommand(command) { this.commands.push(command); }
  addSettingTab(tab) { this.tab = tab; }
}
class FileSystemAdapter { constructor(path) { this.path = path; } getBasePath() { return this.path; } }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class ItemView {}
class MarkdownRenderChild { constructor(containerEl) { this.containerEl = containerEl; } }
class Setting {}
class Notice { constructor(message) { notices.push(message); } }
const obsidian = { Plugin, FileSystemAdapter, PluginSettingTab, ItemView, MarkdownRenderChild, Setting, Notice };
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
      getName() { return 'Fixture vault'; },
      async createFolder(path) { notes.set(path, { path }); },
      async create(path, body) { const note = { path, body }; notes.set(path, note); return note; }
    },
    workspace: {
      getLeavesOfType() { return app.existingLeaves ?? []; },
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
  const protocol = plugin.protocols.get('stash-review');
  assert.equal(typeof protocol, 'function');
  app.existingLeaves = [app.lastLeaf];
  await protocol({repo: 'repoA', stash: 'a'.repeat(40), layer: 'staged', file: 'src/café.ts'});
  assert.deepEqual(app.lastState.state, {repo: 'repoA', stash: 'a'.repeat(40), layer: 'staged', file: 'src/café.ts'});
  assert.equal(app.lastLeaf, app.existingLeaves[0], 'A link must retarget the existing review tab');
  const lastState = app.lastState;
  await protocol({repo: 'repoA', stash: 'stash@{0}'});
  assert.equal(app.lastState, lastState, 'An invalid URI must not navigate to another stash');
  assert.match(notices.at(-1), /full stash commit hash/);
  const children = [];
  const block = plugin.blocks.get('stash-review');
  assert.equal(typeof block, 'function');
  block(`repo: repoA\nstash: ${'a'.repeat(40)}`, {}, {addChild(child) { children.push(child); }});
  assert.equal(children.length, 1, 'Valid embeds register an Obsidian-managed child component');
  assert.ok(children[0] instanceof MarkdownRenderChild);
  const errors = [];
  block('https://example.com/invalid', {empty() {}, addClass() {}, createEl(tag, attributes) { errors.push({tag, text: attributes.text}); }}, {addChild() { assert.fail('Invalid embeds must not mount a review'); }});
  assert.equal(errors[0].text, 'Cannot display this stash review');
  let updatedReview;
  const unsubscribe = host.subscribeMetadata((repositoryId, hash) => { updatedReview = {repositoryId, hash}; });
  const metadata = { title: 'Review prototype', description: 'Remember this idea', tags: ['idea'], pinned: true, reviewedFiles: ['app.ts'], annotations: [] };
  await Promise.all([
    host.saveMetadata('repoA', 'a'.repeat(40), metadata),
    host.saveMetadata('repoB', 'b'.repeat(40), { ...metadata, title: 'Different repository' })
  ]);
  assert.equal(plugin.saved.at(-1).reviews.repoA['a'.repeat(40)].title, metadata.title);
  assert.equal(plugin.saved.at(-1).reviews.repoB['b'.repeat(40)].title, 'Different repository');
  assert.deepEqual(updatedReview, {repositoryId: 'repoB', hash: 'b'.repeat(40)});
  unsubscribe();
  const originalPersist = plugin.persist.bind(plugin);
  const finishWrites = [];
  plugin.persist = () => new Promise((resolve, reject) => {finishWrites.push(() => {void originalPersist().then(resolve, reject);});});
  const firstEdit = host.updateMetadata('repoC', 'c'.repeat(40), previous => ({...previous, pinned: true}));
  const secondEdit = host.updateMetadata('repoC', 'c'.repeat(40), previous => ({...previous, description: 'Another view can edit while persistence is pending'}));
  assert.equal(host.getMetadata('repoC', 'c'.repeat(40)).pinned, true, 'Concurrent edits must use the authoritative shared metadata');
  assert.equal(host.getMetadata('repoC', 'c'.repeat(40)).description, 'Another view can edit while persistence is pending');
  finishWrites.forEach(finish => finish());
  await Promise.all([firstEdit.saved, secondEdit.saved]);
  plugin.persist = originalPersist;
  assert.equal(plugin.saved.at(-1).reviews.repoC['c'.repeat(40)].pinned, true);
  const loaded = host.getMetadata('repoA', 'a'.repeat(40));
  loaded.tags.push('local mutation');
  assert.deepEqual(host.getMetadata('repoA', 'a'.repeat(40)).tags, ['idea']);
  const repository = { id: 'repoA', name: 'Fixture', path: sandbox, branch: 'main', dirty: false };
  const stash = { hash: 'a'.repeat(40), ref: 'stash@{0}', message: 'Prototype', branch: 'main', createdAt: new Date().toISOString(), baseHash: 'b'.repeat(40) };
  let diffReads = 0, sourceReads = 0, stashReads = 0;
  const file = {path: 'app.ts', status: 'modified', additions: 1, deletions: 1, binary: false, hunks: [{header: '@@ -1 +1 @@', oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [{type: 'add', text: 'saved', newLine: 1}]}]};
  plugin.git.getDiff = async () => {diffReads++; await new Promise(resolve => setTimeout(resolve, 5)); return structuredClone([file]);};
  plugin.git.getFileContents = async () => {sourceReads++; return {oldContent: 'before', newContent: 'saved'};};
  plugin.git.listStashes = async () => {stashReads++; return [stash];};
  const snapshots = await Promise.all(Array.from({length: 6}, () => host.getDiff(repository, stash, 'all', 3)));
  assert.equal(diffReads, 1, 'Identical embed reads must share one Git request');
  assert.equal(await host.getDiff(repository, stash, 'all', 3), snapshots[0], 'Immutable snapshots are reusable');
  assert.throws(() => {snapshots[0][0].hunks[0].lines[0].text = 'corrupted';}, TypeError);
  await host.getDiff(repository, stash, 'staged', 3);
  await host.getDiff(repository, stash, 'all', 10);
  assert.equal(diffReads, 3, 'Layer and context must be part of cache identity');
  await Promise.all(Array.from({length: 6}, () => host.getFileContents(repository, stash, file, 'all')));
  await host.getFileContents(repository, stash, file, 'all');
  assert.equal(sourceReads, 1, 'Full source is shared across embeds and repeated copies');
  await Promise.all(Array.from({length: 6}, () => host.listStashes(repository)));
  await host.listStashes(repository);
  assert.equal(stashReads, 2, 'Refreshing a mutable stash list must read Git again');
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
  assert.ok(notes.get(exported).body.includes('obsidian://stash-review?vault=Fixture+vault&repo=repoA&stash=' + stash.hash));
  assert.equal(app.lastFile.path, exported);
  console.log('Plugin bundle passed: CommonJS loading, commands, URI targeting, Markdown registration, shared metadata, persistence, self-file protection and live links in vault exports.');
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
