// Reproducible performance audit. Git mutations occur only in a verified temp folder.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire, builtinModules} from 'node:module';
import {cpus, tmpdir, totalmem, platform, release} from 'node:os';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';
import {mkdtemp, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import vm from 'node:vm';
import {gzipSync, brotliCompressSync} from 'node:zlib';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const samples = Math.max(3, Number(option('--samples', '9')));
const section = option('--section', 'all');
const sourceRef = option('--ref', '');
const output = resolve(root, option('--output', 'benchmarks/results/latest.json'));
const require = createRequire(import.meta.url);
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
const git = (path, parameters, input) => execFileSync('git', ['--literal-pathspecs', '-C', path, '-c', 'core.fsmonitor=false', ...parameters], {encoding: 'utf8', env: gitEnv, input, windowsHide: true, maxBuffer: 64 * 1024 * 1024});
const ref = sourceRef ? git(root, ['rev-parse', '--verify', sourceRef + '^{commit}']).trim() : '';
const revision = git(root, ['rev-parse', 'HEAD']).trim();
const oldSources = new Map();
const readSource = async path => {
  if (!ref) return readFile(join(root, path), 'utf8');
  if (!oldSources.has(path)) oldSources.set(path, git(root, ['show', ref + ':' + path]));
  return oldSources.get(path);
};
const plugins = ref ? [{
  name: 'benchmark-revision',
  setup(builder) {
    builder.onLoad({filter: /\.[cm]?[jt]sx?$/}, async ({path}) => {
      const local = relative(root, path).split(sep).join('/');
      if (!local.startsWith('src/')) return;
      return {contents: await readSource(local), loader: local.endsWith('tsx') ? 'tsx' : 'ts'};
    });
  }
}] : [];
const bundle = async configuration => (await build({bundle: true, write: false, minify: true, target: 'es2022', plugins, define: {'process.env.NODE_ENV': '"production"'}, ...configuration})).outputFiles[0].text;
const moduleSource = await bundle({
  stdin: {contents: [
    "export * from './src/git';", "export * from './src/review-store';", "export * from './src/types';",
    "export * from './src/ui/format';", "export * from './src/ui/file-tree';", "export * from './src/ui/word-diff';",
    "export * from './src/markdown';", "export * from './scripts/benchmark-fixtures';"
  ].join('\n'), resolveDir: root, loader: 'ts'}, format: 'esm', platform: 'node', external: [...builtinModules, ...builtinModules.map(name => 'node:' + name)]
});
const api = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
const report = {
  schemaVersion: 1,
  source: {commit: ref || revision, workingTree: !ref && Boolean(git(root, ['status', '--porcelain']).trim()), computeBundleSha256: createHash('sha256').update(moduleSource).digest('hex')},
  environment: {node: process.version, git: git(root, ['--version']).trim(), os: platform() + ' ' + release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryGiB: +(totalmem() / 1024 ** 3).toFixed(1), explicitGC: typeof global.gc === 'function'},
  methodology: {
    samples, statistics: 'Median and nearest-rank p95; raw samples retained.',
    cold: 'Fresh service/page/module workloads; OS disk caches are not flushed.',
    browser: 'Production React bundle; synthetic Git host to isolate UI cost. Native-host Git costs measured separately.',
    nativeHost: 'Actual plugin bundle through an Obsidian API shim; metadata serialization writes a real temporary file.',
    thresholds: 'Targets for this audit, not universal guarantees. Browser timings include two animation frames and wait for deferred content intersecting the visible scroll viewport; background prefetch outside it is excluded.'
  },
  startedAt: new Date().toISOString(), metrics: [], browserErrors: [], coverage: [], memory: []
};
await mkdir(dirname(output), {recursive: true});
async function checkpoint() {
  const pending = output + '.pending';
  await writeFile(pending, JSON.stringify(report, null, 2) + '\n', 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {await rename(pending, output); return;}
    catch (error) {
      if (attempt >= 4 || !['EACCES', 'EPERM', 'EBUSY', 'UNKNOWN'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const round = value => +value.toFixed(3);
  return {samples: values.length, medianMs: round(median), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]), minMs: round(sorted[0]), maxMs: round(sorted.at(-1)), rawMs: values.map(round)};
}
async function record(name, group, values, targetMs, details = {}) {
  const metric = {name, group, ...summary(values), targetMs, ...details};
  metric.withinTarget = metric.p95Ms <= targetMs;
  report.metrics.push(metric);
  process.stdout.write(name + ': median ' + metric.medianMs + ' ms; p95 ' + metric.p95Ms + ' ms' + (metric.withinTarget ? '' : ' [over target]') + '\n');
  await checkpoint();
}
async function measure(name, group, operation, targetMs, {count = samples, batch = 1, warmup = true, details = {}} = {}) {
  if (warmup) await operation(-1);
  const values = [];
  for (let sample = 0; sample < count; sample++) {
    const start = performance.now();
    for (let index = 0; index < batch; index++) await operation(sample * batch + index);
    values.push((performance.now() - start) / batch);
  }
  await record(name, group, values, targetMs, details);
}

async function computeBenchmarks() {
  report.coverage.push('Patch parsing, tree build/filter/flatten, full context, syntax cold/warm/cache churn/large fallback, inline diff, metadata load/clone/serialize/export, Markdown targets.');
  const files = Array.from({length: 5000}, (_, index) => api.fixtureFile(index, 20, 3));
  for (const size of [12, 1000, 5000]) {
    const paths = files.slice(0, size), viewed = paths.filter((_, index) => index % 2 === 0).map(file => file.path);
    const tree = api.buildFileTree(paths, viewed);
    await measure('tree.build.' + size, 'compute', () => api.buildFileTree(paths, viewed), size === 12 ? 5 : 30, {batch: 5});
    await measure('tree.filter.' + size, 'compute', () => api.filterFileTree(tree, 'module-002'), 20, {batch: 20});
    await measure('tree.flatten.' + size, 'compute', () => api.flattenFileTree(tree), 20, {batch: 20});
    const patch = paths.map(file => [
      'diff --git a/' + file.path + ' b/' + file.path, '--- a/' + file.path, '+++ b/' + file.path,
      file.hunks[0].header, ...file.hunks[0].lines.map(line => (line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ') + line.text), ''
    ].join('\n')).join('\n');
    assert.equal(api.parseDiff(patch).length, size);
    await measure('patch.parse.' + size, 'compute', () => api.parseDiff(patch), size === 12 ? 5 : 50, {batch: size === 5000 ? 1 : 5, details: {patchBytes: Buffer.byteLength(patch)}});
  }
  for (const size of [12_000, 180_000, 900_000]) {
    const source = 'export const captured = "safe <text>";\n'.repeat(Math.ceil(size / 38)).slice(0, size);
    await measure('syntax.cold.' + size, 'compute', index => api.highlightedLines(source + '\n// cold-' + index, 'benchmark.ts'), 50, {warmup: false});
    api.highlightedLines(source, 'benchmark.ts');
    await measure('syntax.warm.' + size, 'compute', () => api.highlightedLines(source, 'benchmark.ts'), 5, {batch: 100});
  }
  await measure('syntax.cache-churn.64-files', 'compute', index => {
    for (let file = 0; file < 64; file++) api.highlightedLines(files[file].oldContent + '// churn-' + index, files[file].path);
  }, 50);
  for (const size of [80, 5000, 20_000]) {
    const file = api.fixtureFile(0, size, 3);
    assert.equal(api.fullContextLines(file).filter(line => line.newLine !== undefined).length, size);
    await measure('context.expand.' + size, 'compute', () => api.fullContextLines(file), 30, {batch: 5});
  }
  for (const size of [80, 20_000]) {
    const before = 'variable_' + 'x'.repeat(size) + 'Old', after = 'variable_' + 'x'.repeat(size) + 'New';
    const range = api.changeRanges(before, after);
    await measure('inline.range.' + size, 'compute', () => api.changeRanges(before, after), 10, {batch: 10});
    await measure('inline.mark.' + size, 'compute', () => api.markChangedText(api.escapeHtml(after), range.next), 10, {batch: 10});
  }
  const repository = {id: 'benchmark-repo', path: '/Benchmark/repository', name: 'benchmark', branch: 'main', dirty: false};
  const stash = {hash: 'a'.repeat(40), message: 'Benchmark', branch: 'main', ref: 'stash@{0}', baseHash: 'b'.repeat(40), createdAt: '2026-10-12T08:00:00Z'};
  for (const notes of [10, 1000, 5000]) {
    const metadata = api.fixtureMetadata(files.slice(0, 12), notes);
    const data = {version: 1, settings: api.DEFAULT_SETTINGS, reviews: {'benchmark-repo': {[stash.hash]: metadata}}};
    await measure('metadata.load.' + notes, 'compute', () => api.loadPluginData(data), 10, {batch: 10});
    await measure('metadata.clone.' + notes, 'compute', () => api.readMetadata(data, repository.id, stash.hash), 30, {batch: 5});
    await measure('metadata.serialize.' + notes, 'compute', () => JSON.stringify(data), 30, {batch: 5, details: {jsonBytes: Buffer.byteLength(JSON.stringify(data))}});
    await measure('metadata.export.' + notes, 'compute', () => api.reviewMarkdown(repository, stash, metadata, 'Benchmark vault'), 30, {batch: 5});
  }
  const link = api.createReviewLink('Benchmark vault', {repositoryId: repository.id, stashHash: stash.hash, file: files[0].path});
  await measure('markdown.link-and-parse', 'compute', () => api.parseReviewBlock(api.createReviewLink('Benchmark vault', {repositoryId: repository.id, stashHash: stash.hash, file: files[0].path})), 2, {batch: 100});
  assert.equal(api.parseReviewBlock(link).stashHash, stash.hash);
  global.gc?.();
  report.memory.push({name: 'node.compute.after-gc', heapMiB: +(process.memoryUsage().heapUsed / 1024 ** 2).toFixed(2)});
}

function instrumentGit(service) {
  const run = service.run.bind(service);
  const calls = [];
  service.run = async (path, parameters) => {
    const start = performance.now();
    try {return await run(path, parameters);}
    finally {calls.push({command: parameters[0], durationMs: performance.now() - start});}
  };
  return calls;
}

async function nativePlugin(repositoryPath, dataPath) {
  const code = await bundle({entryPoints: [join(root, 'src/main.ts')], format: 'cjs', platform: 'node', external: ['obsidian', 'electron', ...builtinModules, ...builtinModules.map(name => 'node:' + name)]});
  class Plugin {
    constructor(app) {this.app = app; this.manifest = {id: 'stash-review'};}
    async loadData() {return {settings: {...api.DEFAULT_SETTINGS, repositories: [repositoryPath]}, reviews: {}, version: 1};}
    async saveData(data) {await writeFile(dataPath, JSON.stringify(data), 'utf8');}
    registerView() {} registerObsidianProtocolHandler() {} registerMarkdownCodeBlockProcessor() {}
    addRibbonIcon() {} addCommand() {} addSettingTab() {}
  }
  class FileSystemAdapter {getBasePath() {return repositoryPath;}}
  class PluginSettingTab {constructor(app, plugin) {this.app = app; this.plugin = plugin;}}
  class ItemView {} class MarkdownRenderChild {} class Setting {} class Notice {}
  const obsidian = {Plugin, FileSystemAdapter, PluginSettingTab, ItemView, MarkdownRenderChild, Setting, Notice};
  const mod = {exports: {}};
  const wrapper = vm.runInThisContext('(function(exports,require,module){\n' + code + '\n})', {filename: 'benchmark-plugin.cjs'});
  const start = performance.now();
  wrapper(mod.exports, name => name === 'obsidian' ? obsidian : require(name), mod);
  const initializationMs = performance.now() - start;
  const plugin = new mod.exports.default({vault: {adapter: new FileSystemAdapter(), getName: () => 'Benchmark vault'}, workspace: {}});
  await plugin.onload();
  return {plugin, initializationMs, bytes: Buffer.byteLength(code)};
}

async function gitBenchmarks() {
  report.coverage.push('Real Windows Git: repository resolve/status, stash list up to 1000 entries, all/staged/unstaged diffs, full source, create/apply/drop/undo, duplicate reads across six embeds, native metadata writes.');
  const sandbox = resolve(await mkdtemp(join(tmpdir(), 'stash-review-bench-')));
  assert.equal(dirname(sandbox), resolve(tmpdir()));
  assert.ok(basename(sandbox).startsWith('stash-review-bench-'));
  try {
    const path = join(sandbox, 'repository');
    await mkdir(path);
    git(path, ['init', '--initial-branch=main']);
    git(path, ['config', 'user.name', 'Benchmark']); git(path, ['config', 'user.email', 'benchmark@example.invalid']);
    git(path, ['config', 'core.autocrlf', 'false']);
    const files = Array.from({length: 120}, (_, index) => api.fixtureFile(index, 80, 3));
    for (const file of files) {await mkdir(dirname(join(path, file.path)), {recursive: true}); await writeFile(join(path, file.path), file.oldContent, 'utf8');}
    git(path, ['add', '--all']); git(path, ['commit', '--quiet', '-m', 'Benchmark base']);
    const service = new api.GitService(), calls = instrumentGit(service);
    const repository = await service.resolveRepository(path);
    for (const file of files) await writeFile(join(path, file.path), file.newContent, 'utf8');
    git(path, ['add', '--', files[0].path]);
    await writeFile(join(path, 'new-note.txt'), 'A captured untracked note.\n', 'utf8');
    await service.createStash(repository, 'First snapshot', true);
    const [first] = await service.listStashes(repository);
    await writeFile(join(path, files[0].path), files[0].newContent + '// second snapshot\n', 'utf8');
    await service.createStash(repository, 'Second snapshot', false);
    const [second] = await service.listStashes(repository);
    const beforeCalls = calls.length;
    await measure('git.resolve.120-files', 'git', () => service.resolveRepository(path), 500, {details: {files: files.length}});
    await measure('git.list.2-stashes', 'git', () => service.listStashes(repository), 200);
    for (const layer of ['all', 'staged', 'unstaged']) await measure('git.diff.' + layer + '.120-files', 'git', () => service.getDiff(repository, first, layer, 3), 500);
    const diff = await service.getDiff(repository, first, 'all', 3);
    assert.equal(diff.length, 121);
    const source = await service.getFileContents(repository, first, diff[0], 'all');
    assert.equal(source.newContent, files[0].newContent);
    await measure('git.source.saved-file', 'git', () => service.getFileContents(repository, first, diff[0], 'all'), 500);
    await measure('git.mutation.create', 'git', async index => {
      await writeFile(join(path, files[0].path), files[0].oldContent + '// create-' + index + '\n', 'utf8');
      await service.createStash(repository, 'Create benchmark ' + index, false);
    }, 1500, {warmup: false, count: Math.min(samples, 5)});
    await measure('git.mutation.apply-index', 'git', async () => {
      git(path, ['reset', '--hard', '--quiet', 'HEAD']);
      await service.applyStash(repository, second, true);
      git(path, ['reset', '--hard', '--quiet', 'HEAD']);
    }, 1500, {warmup: false, count: Math.min(samples, 5), details: {includes: 'hard reset before and after apply, confined to the disposable fixture repository'}});
    await measure('git.mutation.drop-and-undo', 'git', async () => {
      const [stash] = await service.listStashes(repository);
      await service.dropStash(repository, stash); await service.restoreDroppedStash(repository, stash);
    }, 2500, {warmup: false, count: Math.min(samples, 5)});
    const transactionLines = [];
    let current = git(path, ['rev-parse', 'refs/stash']).trim();
    for (let index = 0; index < 1000; index++) {
      const next = current === first.hash ? second.hash : first.hash;
      transactionLines.push('start', 'update refs/stash ' + next + ' ' + current, 'prepare', 'commit');
      current = next;
    }
    git(path, ['update-ref', '--create-reflog', '-m', 'On main: Benchmark reflog entry', '--stdin'], transactionLines.join('\n') + '\n');
    const count = (await service.listStashes(repository)).length;
    assert.ok(count >= 1000);
    await measure('git.list.1000-reflog-entries', 'git', () => service.listStashes(repository), 200, {details: {entries: count, distinctSnapshots: 2, note: 'UI 1000-stash workload uses distinct hashes; Git load here measures reflog volume.'}});
    const native = await nativePlugin(path, join(sandbox, 'review-data.json'));
    await record('plugin.bundle.evaluate', 'native-host', [native.initializationMs], 100, {bytes: native.bytes});
    const nativeCalls = instrumentGit(native.plugin.git), host = native.plugin.createHost();
    const [nativeRepository] = await host.listRepositories();
    for (const [name, operation] of [
      ['repositories', () => host.listRepositories()],
      ['stashes', () => host.listStashes(nativeRepository)],
      ['diff', () => host.getDiff(nativeRepository, first, 'all', 3)],
      ['source', () => host.getFileContents(nativeRepository, first, diff[0], 'all')]
    ]) {
      const startCount = nativeCalls.length;
      await measure('host.six-identical-reads.' + name, 'native-host', () => {
        native.plugin.reads?.clear();
        return Promise.all(Array.from({length: 6}, operation));
      }, 600, {warmup: false, count: 3, details: {cache: 'Retained host results cleared before each sample; simultaneous readers share a cold request.'}});
      report.metrics.at(-1).gitCommands = nativeCalls.length - startCount;
      await checkpoint();
      if (name === 'diff' || name === 'source') await measure('host.repeated-read.' + name, 'native-host', operation, 10, {batch: 20});
    }
    const metadata = api.fixtureMetadata(files, 20);
    const reviews = {};
    for (let index = 0; index < 1000; index++) reviews[(index + 1).toString(16).padStart(40, '0')] = {...metadata, title: 'Review ' + index};
    native.plugin.data.reviews[nativeRepository.id] = reviews;
    await measure('host.persist.1000-reviews', 'native-host', () => host.updateMetadata(nativeRepository.id, first.hash, previous => ({...previous, title: 'Persistence benchmark'})).saved, 100, {details: {jsonBytes: Buffer.byteLength(JSON.stringify(native.plugin.data))}});
    native.plugin.onunload();
    report.gitCommands = calls.slice(beforeCalls).reduce((result, call) => {result[call.command] = (result[call.command] ?? 0) + 1; return result;}, {});
    await checkpoint();
  } finally {
    assert.equal(dirname(sandbox), resolve(tmpdir()));
    assert.ok(basename(sandbox).startsWith('stash-review-bench-'));
    await rm(sandbox, {recursive: true, force: true, maxRetries: 3, retryDelay: 250});
  }
}

const afterPaint = page => page.evaluate(() => window.benchmark.paint());
async function browserTiming(page, action, value) {
  return page.evaluate(async ({action, value}) => {
    const app = document.querySelector('.sr-app');
    const click = label => {
      const button = [...app.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent.trim() === label);
      if (!button || button.disabled) throw new Error('Benchmark control unavailable: ' + label);
      button.click();
    };
    const input = (label, text) => {
      const element = app.querySelector('input[aria-label="' + label + '"], textarea[aria-label="' + label + '"]');
      const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
      setter.call(element, text); element.dispatchEvent(new Event('input', {bubbles: true}));
    };
    const start = performance.now();
    switch (action) {
      case 'click': click(value); break;
      case 'tab': app.querySelectorAll('[role="tab"]')[value].click(); break;
      case 'file-filter': input('Filter changed files', value); break;
      case 'stash-filter': input('Search stashes', value); break;
      case 'stash': app.querySelectorAll('.sr-stash-card')[value].click(); break;
      case 'layer': click(value === 'all' ? 'All changes' : value === 'staged' ? 'Staged' : 'Unstaged'); break;
      case 'context': {const control = app.querySelector('select[aria-label="Diff context lines"]'); control.value = String(value); control.dispatchEvent(new Event('change', {bubbles: true})); break;}
      case 'refresh': click('Refresh stashes'); break;
      case 'scroll-end': {const region = app.querySelector(value); region.scrollTop = region.scrollHeight; break;}
      case 'walk-next': app.querySelector('.sr-diff-code .sr-deferred-placeholder')?.parentElement.scrollIntoView({block: 'center', behavior: 'instant'}); break;
      case 'annotation': app.querySelector('.sr-diff-file button[aria-label="Annotate new line 2"]').click(); break;
      case 'annotation-body': input('Annotation text', value); break;
      case 'save-annotation': app.querySelector('.sr-composer button[type="submit"]').click(); break;
      case 'resolve': [...app.querySelectorAll('button')].find(button => button.textContent.trim() === 'Resolve thread').click(); break;
      case 'reviewed': app.querySelector('.sr-reviewed-control input').click(); break;
      case 'menu': click('More stash actions'); break;
      case 'file-end': {
        const row = app.querySelector('.sr-file-tree [role="treeitem"]');
        row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true})); break;
      }
      default: throw new Error('Unknown benchmark action: ' + action);
    }
    await window.benchmark.paint();
    return performance.now() - start;
  }, {action, value});
}

async function browserBenchmarks() {
  report.coverage.push('Production browser: initial paint, layer/layout/scope switching, stash/file search, navigation, full context, collapse, annotation save/resolve, viewed progress, clipboard/Markdown/export, six embeds, repeated mount/unmount and heap, 1x/4x CPU.');
  const code = await bundle({entryPoints: [join(root, 'scripts/benchmark-browser.tsx')], format: 'esm', platform: 'browser'});
  const css = (await readSource('preview/demo.css')) + '\n' + (await readSource('styles.css'));
  report.browserBundle = {sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length, brotliBytes: brotliCompressSync(code).length};
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body class="theme-dark"><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', request.url === '/app.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/app.js' ? code : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  report.environment.chromium = browser.version();
  try {
    for (const cpuRate of option('--cpu', '1,4').split(',').map(Number)) {
      for (const scenario of option('--workloads', Object.keys(api.workloads).join(',')).split(',')) {
        const [width, height] = option('--viewport', '1440x900').split('x').map(Number);
        const context = await browser.newContext({viewport: {width, height}, reducedMotion: 'reduce'});
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const page = await context.newPage();
        page.on('pageerror', error => report.browserErrors.push({scenario, cpuRate, message: error.message}));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', {rate: cpuRate});
        await cdp.send('Network.setCacheDisabled', {cacheDisabled: true});
        const prefix = 'ui.' + scenario + '.' + cpuRate + 'x.';
        const initial = [];
        const startups = Math.min(samples, scenario === 'dense-large-file' || scenario === 'many-files' || scenario === 'many-notes' ? 3 : 5);
        for (let sample = 0; sample < startups; sample++) {
          await page.goto(url + '/?scenario=' + scenario, {waitUntil: 'domcontentloaded'});
          const ready = await page.waitForFunction(() => window.benchmark && document.querySelector('.sr-code') && window.benchmark.host.counts.source > 0, undefined, {timeout: 60_000});
          await ready.dispose();
          await afterPaint(page);
          initial.push(await page.evaluate(() => performance.now()));
        }
        await record(prefix + 'initial-paint', 'browser', initial, scenario === 'typical' ? 500 : 2000, {scenario, cpuRate, viewport: {width, height}, workload: api.workloads[scenario]});
        const count = Math.min(samples, 5);
        const run = async (name, action, value, reset) => {
          const values = [];
          for (let sample = 0; sample < count; sample++) {
            if (reset) await reset(sample);
            values.push(await browserTiming(page, action, typeof value === 'function' ? value(sample) : value));
          }
          await record(prefix + name, 'browser', values, cpuRate === 1 ? 100 : 200, {scenario, cpuRate});
        };
        await run('wrap', 'click', 'Wrap code lines');
        for (const layer of ['staged', 'unstaged', 'all']) await run('layer-' + layer, 'layer', layer, () => browserTiming(page, 'layer', layer === 'all' ? 'staged' : 'all'));
        await run('context-lines', 'context', sample => sample % 2 ? 3 : 10);
        await browserTiming(page, 'context', 3);
        await run('refresh-stashes', 'refresh');
        await run('single-file', 'click', 'Single file', () => browserTiming(page, 'click', 'All files'));
        await run('split', 'click', 'Split diff', () => browserTiming(page, 'click', 'Unified diff'));
        await run('unified', 'click', 'Unified diff', () => browserTiming(page, 'click', 'Split diff'));
        if (scenario !== 'multi-embed') {
          await run('stash-filter', 'stash-filter', 'Saved work 1', () => browserTiming(page, 'stash-filter', ''));
          await run('stash-filter-clear', 'stash-filter', '', () => browserTiming(page, 'stash-filter', 'Saved work 1'));
          await run('stash-switch', 'stash', 1, () => browserTiming(page, 'stash', 0));
          await browserTiming(page, 'stash', 0);
        }
        await browserTiming(page, 'click', 'Unified diff');
        if (api.workloads[scenario].files > 1) {
          await browserTiming(page, 'click', 'Toggle file navigator').catch(() => {});
          await run('file-filter', 'file-filter', 'module-0005', () => browserTiming(page, 'file-filter', ''));
          await run('file-filter-clear', 'file-filter', '', () => browserTiming(page, 'file-filter', 'module-0005'));
          await run('file-tree-end-key', 'file-end');
        }
        await run('annotations-tab', 'tab', 1, () => browserTiming(page, 'tab', 0));
        await run('files-tab', 'tab', 0, () => browserTiming(page, 'tab', 1));
        await browserTiming(page, 'click', 'All files');
        await run('collapse-all', 'click', 'Collapse all files', () => browserTiming(page, 'click', 'Expand all files').catch(() => {}));
        await run('expand-all', 'click', 'Expand all files', () => browserTiming(page, 'click', 'Collapse all files').catch(() => {}));
        await browserTiming(page, 'click', 'Single file');
        const path = await page.evaluate(() => document.querySelector('.sr-diff-file').getAttribute('data-file-path'));
        const full = await browserTiming(page, 'click', 'Show full context for ' + path);
        await record(prefix + 'full-context', 'browser', [full], cpuRate === 1 ? 200 : 500, {scenario, cpuRate, lines: api.workloads[scenario].lines});
        await browserTiming(page, 'click', 'Collapse full context for ' + path);
        await run('annotation-open', 'annotation', undefined, () => browserTiming(page, 'click', 'Cancel annotation').catch(() => {}));
        await browserTiming(page, 'annotation-body', 'Benchmark annotation');
        await record(prefix + 'annotation-save', 'browser', [await browserTiming(page, 'save-annotation')], cpuRate === 1 ? 100 : 200, {scenario, cpuRate});
        await record(prefix + 'annotation-resolve', 'browser', [await browserTiming(page, 'resolve')], cpuRate === 1 ? 100 : 200, {scenario, cpuRate});
        await run('viewed-toggle', 'reviewed');
        await run('copy-source', 'click', 'Copy stashed code for ' + path);
        for (const action of ['Copy Markdown link', 'Copy Markdown embed', 'Export review']) {
          await run(action.toLowerCase().replaceAll(' ', '-'), 'click', action, () => browserTiming(page, 'menu'));
        }
        await browserTiming(page, 'reviewed');
        await run('scroll-to-last-code', 'scroll-end', '.sr-diff-scroll');
        if (scenario === 'dense-large-file') {
          const steps = [];
          for (let step = 0; step < 120 && await page.locator('.sr-diff-code .sr-deferred-placeholder').count(); step++) steps.push(await browserTiming(page, 'walk-next'));
          assert.equal(await page.locator('.sr-diff-code .sr-deferred-placeholder').count(), 0, 'Long-session audit must visit every row group');
          if (steps.length) await record(prefix + 'scroll-every-row-group', 'browser', steps, cpuRate === 1 ? 100 : 200, {scenario, cpuRate});
          await run('wrap-after-full-scroll', 'click', 'Wrap code lines');
          await run('annotation-open-after-full-scroll', 'annotation', undefined, () => browserTiming(page, 'click', 'Cancel annotation').catch(() => {}));
          await browserTiming(page, 'annotation-body', 'Annotation after reviewing every row');
          await record(prefix + 'annotation-save-after-full-scroll', 'browser', [await browserTiming(page, 'save-annotation')], cpuRate === 1 ? 100 : 200, {scenario, cpuRate});
        }
        if (scenario === 'many-stashes') await run('scroll-to-last-stash', 'scroll-end', '.sr-stash-list');
        const metrics = await page.evaluate(() => ({
          domNodes: document.querySelectorAll('*').length, codeRows: document.querySelectorAll('.sr-diff-row,.sr-split-row').length,
          listeners: window.benchmark.host.listeners.size, hostReads: window.benchmark.host.counts,
          longTasks: window.benchmark.longTasks.map(task => ({...task, duration: +task.duration.toFixed(2)}))
        }));
        await cdp.send('HeapProfiler.collectGarbage');
        const heap = await cdp.send('Runtime.getHeapUsage');
        report.memory.push({name: prefix + 'end', heapMiB: +(heap.usedSize / 1024 ** 2).toFixed(2), ...metrics});
        if (scenario === 'multi-embed' && cpuRate === 1) {
          await page.evaluate(() => {
            const host = window.benchmark.host;
            return host.updateMetadata(host.repository.id, host.stashes[0].hash, previous => ({...previous, reviewedFiles: []})).saved;
          });
          const cycles = [];
          for (let cycle = 0; cycle < 12; cycle++) {
            await page.evaluate(() => window.benchmark.unmount()); await afterPaint(page);
            assert.equal(await page.evaluate(() => window.benchmark.host.listeners.size), 0);
            await cdp.send('HeapProfiler.collectGarbage');
            const usage = await cdp.send('Runtime.getHeapUsage');
            cycles.push(+(usage.usedSize / 1024 ** 2).toFixed(2));
            await page.evaluate(() => window.benchmark.mount());
            const ready = await page.waitForFunction(() => document.querySelectorAll('.sr-app').length === 6 && !!document.querySelector('.sr-code'));
            await ready.dispose();
            await afterPaint(page);
          }
          report.memory.push({name: 'ui.multi-embed.unmounted-cycles', heapMiB: cycles, growthMiB: +(cycles.at(-1) - cycles[0]).toFixed(2)});
        }
        await checkpoint();
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(report.browserErrors.length, 0, 'Browser runtime errors must be fixed before trusting timings');
}

try {
  if (section === 'all' || section === 'compute') await computeBenchmarks();
  if (section === 'all' || section === 'git') await gitBenchmarks();
  if (section === 'all' || section === 'browser') await browserBenchmarks();
  report.completedAt = new Date().toISOString();
  await checkpoint();
  process.stdout.write('Saved ' + report.metrics.length + ' measurements to ' + relative(root, output) + '\n');
} catch (error) {
  report.failure = {message: error.message, stack: error.stack};
  await checkpoint();
  throw error;
}
