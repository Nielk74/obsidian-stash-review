import { expect, test, type Page } from '@playwright/test';

async function openCapture(page: Page, query = '') {
  await page.goto('/' + query);
  await expect(page.locator('.sr-app')).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Toggle stash sidebar', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  const stash = page.getByRole('button', { name: 'Open stash Ambient note capture', exact: true });
  await expect(stash).toHaveCount(1);
  await stash.click();
  await expect(page.locator('[data-file-path="src/capture.ts"]')).toBeVisible();
}

test('line ranges, replies, and resolved annotations persist after reloading', async ({ page }) => {
  await openCapture(page);
  const file = page.locator('[data-file-path="src/capture.ts"]');
  await file.getByRole('button', { name: 'Annotate new line 20', exact: true }).click();
  await file.getByRole('button', { name: 'Annotate new line 22', exact: true }).click({ modifiers: ['Shift'] });
  await expect(file.getByText('New lines 20–22', { exact: true })).toBeVisible();
  const body = 'Keep an empty capture from creating a file. <img src=x onerror=alert(1)>';
  await file.getByRole('textbox', { name: 'Annotation text', exact: true }).fill(body);
  await file.getByRole('button', { name: 'Save annotation', exact: true }).click();
  const thread = file.locator('.sr-thread').filter({ hasText: body });
  await expect(thread).toBeVisible();
  const annotationId = await thread.getAttribute('data-annotation-id');
  const anchoredThread = file.locator(`[data-annotation-id="${annotationId}"]`);
  await expect(thread.locator('img')).toHaveCount(0);
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  await thread.getByRole('textbox', { name: 'Reply text', exact: true }).fill('Yes, preserve the active editor as well.');
  await thread.getByRole('button', { name: 'Save reply', exact: true }).click();
  await expect(thread.getByText('Yes, preserve the active editor as well.', { exact: true })).toBeVisible();
  await thread.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await expect(anchoredThread.getByText('Resolved', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Open stash Ambient note capture', exact: true }).click();
  const restored = page.locator(`[data-file-path="src/capture.ts"] [data-annotation-id="${annotationId}"]`);
  await restored.getByRole('button', { name: 'View thread', exact: true }).click();
  await expect(restored.getByText(body, { exact: true })).toBeVisible();
  await expect(restored.getByText('Yes, preserve the active editor as well.', { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => window.__demoHost.getMetadata('demo-fieldbook', '8d7be6a901afe7794ed9a6f1a3cb0318409876da').annotations.find(note => note.body.startsWith('Keep an empty capture')));
  expect(saved).toMatchObject({ path: 'src/capture.ts', side: 'new', startLine: 20, endLine: 22, layer: 'all', resolved: true });
  expect(saved?.replies).toHaveLength(1);
});

test('full file context shows immutable surrounding code and can collapse', async ({ page }) => {
  await openCapture(page);
  const file = page.locator('[data-file-path="src/capture.ts"]');
  await file.getByRole('button', { name: 'Show full context for src/capture.ts', exact: true }).click();
  await expect(file.getByText('Full file context', { exact: true })).toBeVisible();
  await expect(file.getByText('async open(result: CaptureResult): Promise<void> {', { exact: false })).toBeVisible();
  await file.getByRole('button', { name: 'Collapse full context for src/capture.ts', exact: true }).click();
  await expect(file.getByText('Full file context', { exact: true })).toHaveCount(0);
  await expect(file.locator('.hljs-keyword').first()).toBeVisible();
  await expect(page.locator('[data-file-path="docs/capture.md"]')).toContainText('docs/quick-capture.md');
  await expect(page.locator('[data-file-path="notes/capture-experiment.md"]')).toContainText('untracked');
  await expect(page.locator('[data-file-path="assets/capture-preview.png"]')).toContainText('Binary file changed');
});

test('dark and light desktop screenshots', async ({ page }, testInfo) => {
  await openCapture(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Split diff', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('desktop-split.png'), fullPage: true });
  await page.getByRole('tab', { name: /Annotations/ }).click();
  await expect(page.locator('.sr-annotations-panel').getByRole('heading', { name: 'Annotations', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-annotations.png'), fullPage: true });
  await page.getByRole('tab', { name: /Files changed/ }).click();
  await page.getByRole('button', { name: 'Unified diff', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await expect(page.locator('body')).toHaveClass('theme-light');
  await page.screenshot({ path: testInfo.outputPath('desktop-light.png'), fullPage: true });
});

test('narrow review has readable code and a keyboard reachable annotation control', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await openCapture(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(430);
  const file = page.locator('[data-file-path="src/capture.ts"]');
  const annotate = file.getByRole('button', { name: 'Annotate new line 20', exact: true });
  await annotate.focus();
  await page.keyboard.press('Enter');
  await expect(file.getByRole('textbox', { name: 'Annotation text', exact: true })).toBeFocused();
  await page.keyboard.type('Keyboard review note');
  await file.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(file.getByText('Keyboard review note', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('narrow-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('narrow-light.png'), fullPage: true });
});

test('stash titles, description, tags, pins, and file progress survive a restart', async ({ page }) => {
  await openCapture(page);
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit stash details', exact: true });
  await dialog.getByRole('textbox', { name: 'Stash title', exact: true }).fill('Capture without losing focus');
  await dialog.getByRole('textbox', { name: 'Stash description', exact: true }).fill('Check appending in nested folders before shipping.');
  await dialog.getByRole('textbox', { name: 'Stash tags', exact: true }).fill('next-up, capture, next-up');
  await dialog.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Capture without losing focus', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pin stash', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Mark src/capture.ts as reviewed', exact: true }).check();
  await expect(page.locator('[data-file-path="src/capture.ts"] .sr-code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show pinned stashes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open stash Mobile reading spacing', exact: true })).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: 'Search stashes', exact: true });
  await search.fill('nested folders');
  await expect(page.getByRole('button', { name: 'Open stash Capture without losing focus', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open stash Command palette refresh', exact: true })).toHaveCount(0);
  await search.fill('no stash matches this');
  await expect(page.getByText('No matching stashes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Capture without losing focus', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unpin stash', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Mark src/capture.ts as reviewed', exact: true })).toBeChecked();
  await expect(page.locator('[data-file-path="src/capture.ts"] .sr-code')).toHaveCount(0);
  const metadata = await page.evaluate(() => window.__demoHost.getMetadata('demo-fieldbook', '8d7be6a901afe7794ed9a6f1a3cb0318409876da'));
  expect(metadata).toMatchObject({ title: 'Capture without losing focus', pinned: true, tags: ['next-up', 'capture'], reviewedFiles: ['src/capture.ts'] });
});

test('diff layers preserve staged versus working changes and split view retains annotations', async ({ page }) => {
  await openCapture(page);
  await page.getByRole('button', { name: 'Staged', exact: true }).click();
  await expect(page.locator('[data-file-path="src/paths.ts"]')).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Changed files', exact: true }).locator('[data-tree-path="assets"]')).toHaveCount(0);
  await expect(page.locator('[data-file-path="styles/capture.css"]')).toHaveCount(0);
  await expect(page.locator('[data-file-path="notes/capture-experiment.md"]')).toHaveCount(0);
  await expect(page.locator('.sr-thread')).toHaveCount(0);
  await page.getByRole('button', { name: 'Unstaged', exact: true }).click();
  await expect(page.locator('[data-file-path="styles/capture.css"]')).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Changed files', exact: true }).locator('[data-tree-path="docs"]')).toHaveCount(0);
  await expect(page.locator('[data-file-path="docs/capture.md"]')).toHaveCount(0);
  await expect(page.locator('[data-file-path="notes/capture-experiment.md"]')).toBeVisible();
  await page.getByRole('button', { name: 'All changes', exact: true }).click();
  await expect(page.locator('[data-file-path="docs/capture.md"]')).toBeVisible();
  await page.getByRole('button', { name: 'Split diff', exact: true }).click();
  const file = page.locator('[data-file-path="src/capture.ts"]');
  await expect(file.locator('.sr-split-row').first()).toBeVisible();
  await file.locator('.sr-split-labels').scrollIntoViewIfNeeded();
  await expect(file.locator('.sr-split-labels').getByText('Before', { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(file.locator('.sr-split-labels').getByText('Stashed changes', { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(file.getByText('Before', { exact: true })).toBeVisible();
  await expect(file.getByText('Stashed changes', { exact: true })).toBeVisible();
  await expect(file.locator('[data-annotation-id="demo-question"]')).toBeVisible();
  await page.getByRole('combobox', { name: 'Diff context lines', exact: true }).selectOption('10');
  await expect(file.getByRole('button', { name: 'Annotate new line 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Unified diff', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Filter changed files', exact: true }).fill('does-not-exist');
  await expect(page.getByRole('heading', { name: 'No matching files', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear file filter', exact: true }).click();
  await expect(file).toBeVisible();
});

test('mutation dialogs guard dirty apply, create explicitly, and recover a dropped stash', async ({ page }) => {
  await openCapture(page);
  await page.getByRole('button', { name: 'Apply stash', exact: true }).click();
  const apply = page.getByRole('dialog', { name: 'Apply this stash?', exact: true });
  expect(await page.evaluate(() => window.__demoHost.operations)).toEqual([]);
  await apply.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(apply.getByRole('alert')).toContainText('working tree has local changes');
  await apply.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Create stash', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create a stash', exact: true });
  await create.getByRole('textbox', { name: 'Stash message', exact: true }).fill('capture checkpoint');
  await create.getByRole('checkbox', { name: /Include untracked files/ }).uncheck();
  expect(await page.evaluate(() => window.__demoHost.operations)).toEqual([]);
  await create.getByRole('button', { name: 'Create stash', exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open stash capture checkpoint', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__demoHost.operations[0])).toMatchObject({ name: 'create', includeUntracked: false });
  expect(await page.evaluate(async () => (await window.__demoHost.listRepositories())[0].dirty)).toBe(false);
  await page.getByRole('button', { name: 'Open stash capture checkpoint', exact: true }).click();
  await expect(page.locator('[data-file-path="notes/capture-experiment.md"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Apply stash', exact: true }).click();
  await apply.getByRole('checkbox', { name: /Restore staged changes/ }).check();
  await apply.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(apply).toHaveCount(0);
  expect(await page.evaluate(() => window.__demoHost.operations[1])).toMatchObject({ name: 'apply', restoreIndex: true });
  await expect(page.getByRole('button', { name: 'Open stash capture checkpoint', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More stash actions', exact: true }).click();
  await page.getByRole('button', { name: 'Drop stash', exact: true }).click();
  const drop = page.getByRole('dialog', { name: 'Drop this stash?', exact: true });
  expect(await page.evaluate(() => window.__demoHost.operations.filter(operation => operation.name === 'drop'))).toEqual([]);
  await drop.getByRole('button', { name: 'Keep stash', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open stash capture checkpoint', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More stash actions', exact: true }).click();
  await page.getByRole('button', { name: 'Drop stash', exact: true }).click();
  await drop.getByRole('button', { name: 'Drop stash', exact: true }).click();
  await expect(drop).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open stash capture checkpoint', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo drop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open stash capture checkpoint', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__demoHost.operations.map(operation => operation.name))).toEqual(['create', 'apply', 'drop', 'restore']);
});

test('empty, repository error, and unavailable diff states have useful recovery controls', async ({ page }) => {
  await page.goto('/?state=empty');
  await expect(page.getByText('A clean slate', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create your first stash', exact: true })).toBeVisible();
  await page.goto('/?state=error');
  await expect(page.getByText('Cannot load repositories', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry repositories', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry repositories', exact: true }).click();
  await expect(page.getByText('Git could not open the demo repository.', { exact: false })).toBeVisible();
  await page.goto('/?state=diff-error');
  await expect(page.getByRole('heading', { name: 'Could not load this diff', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry diff', exact: true })).toBeVisible();
  await page.goto('/?state=no-repository');
  await page.getByRole('button', { name: 'Connect a repository', exact: true }).click();
  const connect = page.getByRole('dialog', { name: 'Connect a repository', exact: true });
  await connect.getByRole('textbox', { name: 'Repository path', exact: true }).fill('/Demo vault/fieldbook');
  await connect.getByRole('button', { name: 'Connect repository', exact: true }).click();
  await expect(page.locator('[data-file-path="src/capture.ts"]')).toBeVisible();
});

test('keyboard stash browsing does not intercept text entry and Escape closes dialogs', async ({ page }) => {
  await openCapture(page);
  await page.getByRole('button', { name: 'Open stash Ambient note capture', exact: true }).focus();
  await page.keyboard.press('j');
  await expect(page.getByRole('heading', { name: 'Command palette refresh', exact: true })).toBeVisible();
  await page.keyboard.press('k');
  await expect(page.getByRole('heading', { name: 'Ambient note capture', exact: true })).toBeVisible();
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search stashes', exact: true })).toBeFocused();
  await page.getByRole('searchbox', { name: 'Search stashes', exact: true }).fill('j');
  await expect(page.getByRole('heading', { name: 'Ambient note capture', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search stashes', exact: true }).fill('');
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Stash title', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('pending metadata writes retain both annotations when switching stashes', async ({ page }) => {
  await openCapture(page);
  await page.evaluate(() => {
    const state = window as typeof window & { __pendingSaves: Array<() => void> };
    state.__pendingSaves = [];
    const save = window.__demoHost.saveMetadata.bind(window.__demoHost);
    window.__demoHost.saveMetadata = async (repository, hash, metadata) => {
      await save(repository, hash, metadata);
      await new Promise<void>(resolve => state.__pendingSaves.push(resolve));
    };
  });
  const file = page.locator('[data-file-path="src/capture.ts"]');
  for (const [line, body] of [[20, 'First annotation during a slow disk write'], [22, 'Second annotation while the first save is pending']] as const) {
    await file.getByRole('button', { name: `Annotate new line ${line}`, exact: true }).click();
    await file.getByRole('textbox', { name: 'Annotation text', exact: true }).fill(body);
    await file.getByRole('button', { name: 'Save annotation', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Open stash Command palette refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Open stash Ambient note capture', exact: true }).click();
  await expect(file.getByText('First annotation during a slow disk write', { exact: true })).toBeVisible();
  await expect(file.getByText('Second annotation while the first save is pending', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Edit stash details', exact: true });
  await details.getByRole('textbox', { name: 'Stash description', exact: true }).fill('Keep both in-flight annotations when making another edit.');
  await details.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __pendingSaves: Array<() => void> }).__pendingSaves.length)).toBe(3);
  await page.evaluate(() => (window as typeof window & { __pendingSaves: Array<() => void> }).__pendingSaves.splice(0).forEach(resolve => resolve()));
  await expect(details).toHaveCount(0);
  await page.reload();
  await expect(file.getByText('First annotation during a slow disk write', { exact: true })).toBeVisible();
  await expect(file.getByText('Second annotation while the first save is pending', { exact: true })).toBeVisible();
  const metadata = await page.evaluate(() => window.__demoHost.getMetadata('demo-fieldbook', '8d7be6a901afe7794ed9a6f1a3cb0318409876da'));
  expect(metadata.annotations.map(note => note.body)).toEqual(expect.arrayContaining(['First annotation during a slow disk write', 'Second annotation while the first save is pending']));
  expect(metadata.description).toBe('Keep both in-flight annotations when making another edit.');
});

test('export keeps the selected stash snapshot while its save is pending', async ({ page }) => {
  await openCapture(page);
  await page.evaluate(() => {
    const state = window as typeof window & {
      __pendingSaves: Array<() => void>;
      __exportedReview?: { hash: string; title: string; bodies: string[] };
    };
    state.__pendingSaves = [];
    const save = window.__demoHost.saveMetadata.bind(window.__demoHost);
    window.__demoHost.saveMetadata = async (repository, hash, metadata) => {
      await save(repository, hash, metadata);
      await new Promise<void>(resolve => state.__pendingSaves.push(resolve));
    };
    window.__demoHost.exportReview = async (_repository, stash, metadata) => {
      state.__exportedReview = { hash: stash.hash, title: metadata.title, bodies: metadata.annotations.map(note => note.body) };
      return 'snapshot-review.md';
    };
  });
  const file = page.locator('[data-file-path="src/capture.ts"]');
  await file.getByRole('button', { name: 'Annotate new line 20', exact: true }).click();
  await file.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Export belongs to the capture stash.');
  await file.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await page.getByRole('button', { name: 'More stash actions', exact: true }).click();
  await page.getByRole('button', { name: 'Export review', exact: true }).click();
  await page.getByRole('button', { name: 'Open stash Command palette refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Command palette refresh', exact: true })).toBeVisible();
  await page.evaluate(() => (window as typeof window & { __pendingSaves: Array<() => void> }).__pendingSaves.splice(0).forEach(resolve => resolve()));
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __exportedReview?: { hash: string; title: string; bodies: string[] } }).__exportedReview)).toMatchObject({
    hash: '8d7be6a901afe7794ed9a6f1a3cb0318409876da', title: 'Ambient note capture', bodies: expect.arrayContaining(['Export belongs to the capture stash.'])
  });
});

test('an open drop confirmation cannot retarget when Git removes the selected stash', async ({ page }) => {
  await page.clock.install();
  await openCapture(page);
  await page.getByRole('button', { name: 'More stash actions', exact: true }).click();
  await page.getByRole('button', { name: 'Drop stash', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Drop this stash?', exact: true });
  await expect(dialog).toContainText('Ambient note capture');
  await page.evaluate(async () => {
    const repository = (await window.__demoHost.listRepositories())[0];
    const stash = (await window.__demoHost.listStashes())[0];
    await window.__demoHost.dropStash(repository, stash);
  });
  await page.clock.runFor(31_000);
  await expect(dialog).toContainText('Ambient note capture');
  await expect(dialog).not.toContainText('Command palette refresh');
  await dialog.getByRole('button', { name: 'Drop stash', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('no longer in the list');
  const remaining = await page.evaluate(async () => (await window.__demoHost.listStashes()).map(stash => stash.hash));
  expect(remaining).toContain('b45ac04f374a236e7410b2ef592b65a0d7d2f603');
  const operations = await page.evaluate(() => window.__demoHost.operations.filter(operation => operation.name === 'drop'));
  expect(operations).toEqual([{ name: 'drop', hash: '8d7be6a901afe7794ed9a6f1a3cb0318409876da' }]);
});

test('an annotation outside the current hunk reveals its saved layer and full context', async ({ page }) => {
  await openCapture(page);
  const line = await page.evaluate(async () => {
    const host = window.__demoHost;
    const repository = (await host.listRepositories())[0];
    const stash = (await host.listStashes())[0];
    const file = (await host.getDiff(repository, stash, 'all', 3)).find(file => file.path === 'src/capture.ts')!;
    return file.newContent!.split('\n').findIndex(text => text.includes('async open(result:')) + 1;
  });
  const file = page.locator('[data-file-path="src/capture.ts"]');
  await expect(file.getByRole('button', { name: `Annotate new line ${line}`, exact: true })).toHaveCount(0);
  await file.getByRole('button', { name: 'Show full context for src/capture.ts', exact: true }).click();
  await file.getByRole('button', { name: `Annotate new line ${line}`, exact: true }).click();
  await file.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Review opening the saved note without stealing focus.');
  await file.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open stash Command palette refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Open stash Ambient note capture', exact: true }).click();
  await page.getByRole('button', { name: 'Staged', exact: true }).click();
  await page.getByRole('tab', { name: /Annotations/ }).click();
  const annotation = page.locator('.sr-annotations-panel .sr-thread').filter({ hasText: 'Review opening the saved note without stealing focus.' });
  await annotation.locator('.sr-thread-location').click();
  await expect(page.getByRole('button', { name: 'All changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(file.getByText('Full file context', { exact: true })).toBeVisible();
  await expect(file.getByText('Review opening the saved note without stealing focus.', { exact: true })).toBeInViewport();
});

test('changed files use a real hierarchy with nested folders, duplicate names, and directories first', async ({ page }) => {
  await openCapture(page);
  const tree = page.getByRole('tree', { name: 'Changed files', exact: true });
  await expect(tree).toBeVisible();
  const src = tree.locator('[data-tree-path="src"]');
  const capture = tree.locator('[data-tree-path="src/capture"]');
  const ui = tree.locator('[data-tree-path="src/capture/ui"]');
  const modal = tree.locator('[data-tree-path="src/capture/ui/modal.ts"]');
  await expect(src).toHaveAttribute('aria-level', '1');
  await expect(capture).toHaveAttribute('aria-level', '2');
  await expect(ui).toHaveAttribute('aria-level', '3');
  await expect(modal).toHaveAttribute('aria-level', '4');
  await expect(tree.locator('[data-tree-path="src/capture/format.ts"]')).toBeVisible();
  await expect(tree.locator('[data-tree-path="src/utils/format.ts"]')).toBeVisible();
  await expect(tree.locator('[data-tree-path="docs/capture.md"]')).toHaveAccessibleName(/renamed from docs\/quick-capture\.md/);
  await expect(tree.locator('[data-tree-path="assets/capture-preview.png"]')).toHaveAccessibleName(/untracked, binary/);
  await expect(tree.locator('[data-tree-path="notes/capture-experiment.md"]')).toHaveAccessibleName(/untracked/);
  const rootPaths = await tree.locator('[role="treeitem"][aria-level="1"]').evaluateAll(items => items.map(item => item.getAttribute('data-tree-path')));
  expect(rootPaths).toEqual(['assets', 'docs', 'notes', 'src', 'styles', 'tests', 'README.md']);
  const srcPaths = await tree.locator('[role="treeitem"][aria-level="2"]').evaluateAll(items => items.map(item => item.getAttribute('data-tree-path')).filter(path => path?.startsWith('src/')));
  expect(srcPaths).toEqual(['src/capture', 'src/utils', 'src/capture.ts', 'src/paths.ts']);
  await capture.click();
  await expect(capture).toHaveAttribute('aria-expanded', 'false');
  await expect(modal).toHaveCount(0);
  await expect(tree.locator('[data-tree-path="src/utils/format.ts"]')).toBeVisible();
  await capture.click();
  await expect(modal).toBeVisible();
  await page.getByRole('button', { name: 'Collapse all folders', exact: true }).click();
  await expect(tree.locator('[role="treeitem"][aria-level="2"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await expect(modal).toBeVisible();
});

test('file filtering retains and expands matching ancestors and tree/list views retain selection', async ({ page }) => {
  await openCapture(page);
  const tree = page.getByRole('tree', { name: 'Changed files', exact: true });
  await page.getByRole('button', { name: 'Collapse all folders', exact: true }).click();
  const filter = page.getByRole('searchbox', { name: 'Filter changed files', exact: true });
  await filter.fill('modal.ts');
  for (const path of ['src', 'src/capture', 'src/capture/ui']) {
    await expect(tree.locator(`[data-tree-path="${path}"]`)).toHaveAttribute('aria-expanded', 'true');
  }
  await expect(tree.locator('[data-tree-path="src/capture/ui/modal.ts"]')).toBeVisible();
  await expect(tree.locator('[data-tree-path="src/utils"]')).toHaveCount(0);
  await filter.fill('src/capture/');
  await expect(tree.locator('[data-tree-path="src/capture/append.ts"]')).toBeVisible();
  await expect(tree.locator('[data-tree-path="src/capture/format.ts"]')).toBeVisible();
  await filter.fill('format.ts');
  await expect(tree.locator('[data-tree-path="src/capture/format.ts"]')).toBeVisible();
  await expect(tree.locator('[data-tree-path="src/utils/format.ts"]')).toBeVisible();
  await filter.fill('');
  await expect(tree.locator('[data-tree-path="src"]')).toHaveAttribute('aria-expanded', 'false');
  await filter.fill('format.ts');
  await tree.locator('[data-tree-path="src/utils/format.ts"]').click();
  await expect(tree.locator('[data-tree-path="src/utils/format.ts"]')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Show flat file list', exact: true }).click();
  await expect(tree.locator('[aria-expanded]')).toHaveCount(0);
  await expect(tree.locator('[data-tree-path="src/utils/format.ts"]')).toBeVisible();
  await page.getByRole('button', { name: 'Show file tree', exact: true }).click();
  await expect(tree.locator('[data-tree-path="src/utils/format.ts"]')).toHaveAttribute('aria-selected', 'true');
  await filter.fill('');
  await expect(tree.locator('[data-tree-path="src"]')).toHaveAttribute('aria-expanded', 'true');
});

test('tree keyboard navigation stays inside changed files and leaves text entry alone', async ({ page }) => {
  await openCapture(page);
  const tree = page.getByRole('tree', { name: 'Changed files', exact: true });
  await page.getByRole('button', { name: 'Collapse all folders', exact: true }).click();
  const src = tree.locator('[data-tree-path="src"]');
  await src.focus();
  await page.keyboard.press('ArrowRight');
  await expect(src).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  const capture = tree.locator('[data-tree-path="src/capture"]');
  await expect(capture).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(capture).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(capture).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowLeft');
  await expect(src).toBeFocused();
  await page.keyboard.press('End');
  await expect(tree.locator('[data-tree-path="README.md"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tree.locator('[data-tree-path="README.md"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(tree.locator('[data-tree-path="assets"]')).toBeFocused();
  await page.keyboard.press('j');
  await expect(page.getByRole('heading', { name: 'Ambient note capture', exact: true })).toBeVisible();
  const filter = page.getByRole('searchbox', { name: 'Filter changed files', exact: true });
  await filter.fill('format');
  await page.keyboard.press('ArrowLeft');
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue('format');
  await expect(page.getByRole('heading', { name: 'Ambient note capture', exact: true })).toBeVisible();
});

test('folder choices persist for the selected stash while search expansion stays temporary', async ({ page }) => {
  await openCapture(page);
  const tree = page.getByRole('tree', { name: 'Changed files', exact: true });
  await tree.locator('[data-tree-path="src/capture"]').click();
  await expect(tree.locator('[data-tree-path="src/capture"]')).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(tree.locator('[data-tree-path="src/capture"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(tree.locator('[data-tree-path="src/capture/ui/modal.ts"]')).toHaveCount(0);
  await expect(tree.locator('[data-tree-path="src/utils/format.ts"]')).toBeVisible();
  const filter = page.getByRole('searchbox', { name: 'Filter changed files', exact: true });
  await filter.fill('modal.ts');
  await expect(tree.locator('[data-tree-path="src/capture/ui/modal.ts"]')).toBeVisible();
  await filter.fill('');
  await expect(tree.locator('[data-tree-path="src/capture"]')).toHaveAttribute('aria-expanded', 'false');
});

test('viewed files update folder progress and hide viewed preserves metadata and review totals', async ({ page }) => {
  await openCapture(page);
  const tree = page.getByRole('tree', { name: 'Changed files', exact: true });
  const capture = tree.locator('[data-tree-path="src/capture"]');
  await expect(capture).toHaveAccessibleName('src/capture, 3 changed files, 0 viewed');
  for (const path of ['src/capture/append.ts', 'src/capture/format.ts', 'src/capture/ui/modal.ts']) {
    await page.getByRole('checkbox', { name: `Mark ${path} as reviewed`, exact: true }).check();
  }
  await expect(capture).toHaveAccessibleName('src/capture, 3 changed files, 3 viewed');
  await expect(tree.locator('[data-tree-path="src"]')).toHaveAccessibleName('src, 6 changed files, 3 viewed');
  const viewed = page.getByRole('checkbox', { name: 'Hide viewed files', exact: true });
  await viewed.check();
  await expect(capture).toHaveCount(0);
  await expect(page.locator('[data-file-path="src/capture/append.ts"]')).toHaveCount(0);
  await expect(tree.locator('[data-tree-path="src/utils/format.ts"]')).toBeVisible();
  await expect(page.getByText('3 of 12 files viewed', { exact: true })).toBeVisible();
  const metadata = await page.evaluate(() => window.__demoHost.getMetadata('demo-fieldbook', '8d7be6a901afe7794ed9a6f1a3cb0318409876da'));
  expect(metadata.reviewedFiles).toEqual(['src/capture/append.ts', 'src/capture/format.ts', 'src/capture/ui/modal.ts']);
  await viewed.uncheck();
  await expect(capture).toHaveAccessibleName('src/capture, 3 changed files, 3 viewed');
  await expect(page.getByRole('checkbox', { name: 'Mark src/capture/append.ts as reviewed', exact: true })).toBeChecked();
  const append = page.locator('[data-file-path="src/capture/append.ts"]');
  await append.getByRole('button', { name: 'Show full context for src/capture/append.ts', exact: true }).click();
  await expect(append.getByText('Full file context', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Mark src/capture/append.ts as reviewed', exact: true })).toBeChecked();
});

test('single file review follows tree selection and previous/next without losing the complete tree', async ({ page }) => {
  await openCapture(page);
  await expect(page.locator('[data-file-path]')).toHaveCount(12);
  await page.getByRole('button', { name: 'Single file', exact: true }).click();
  await expect(page.locator('[data-file-path]')).toHaveCount(1);
  await expect(page.locator('[data-file-path="src/capture.ts"]')).toBeVisible();
  const tree = page.getByRole('tree', { name: 'Changed files', exact: true });
  await tree.locator('[data-tree-path="src/capture/format.ts"]').click();
  await expect(page.locator('[data-file-path]')).toHaveCount(1);
  await expect(page.locator('[data-file-path="src/capture/format.ts"]')).toBeVisible();
  await expect(tree.locator('[data-tree-path="src/utils/format.ts"]')).toBeVisible();
  await page.getByRole('button', { name: 'Next changed file', exact: true }).click();
  const nextPath = await page.locator('[data-file-path]').getAttribute('data-file-path');
  expect(nextPath).not.toBe('src/capture/format.ts');
  await expect(tree.locator(`[data-tree-path="${nextPath}"]`)).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Previous changed file', exact: true }).click();
  await expect(page.locator('[data-file-path="src/capture/format.ts"]')).toBeVisible();
  await page.getByRole('button', { name: 'All files', exact: true }).click();
  await expect(page.locator('[data-file-path]')).toHaveCount(12);
});

test('narrow file navigator opens the full nested tree and returns to the selected diff', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await openCapture(page);
  await page.getByRole('button', { name: 'Single file', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle file navigator', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Changed files', exact: true });
  await expect(tree).toBeVisible();
  await tree.locator('[data-tree-path="src/capture/ui/modal.ts"]').click();
  await expect(page.locator('[data-file-path="src/capture/ui/modal.ts"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toggle file navigator', exact: true })).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(430);
});

test('an annotation reveals a viewed and collapsed file in single file review', async ({ page }) => {
  await openCapture(page);
  const file = page.locator('[data-file-path="src/capture.ts"]');
  await page.getByRole('checkbox', { name: 'Mark src/capture.ts as reviewed', exact: true }).check();
  await page.getByRole('button', { name: 'Collapse all files', exact: true }).click();
  await expect(file.locator('.sr-code')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Hide viewed files', exact: true }).check();
  await page.getByRole('button', { name: 'Single file', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Filter changed files', exact: true }).fill('format.ts');
  await page.getByRole('tab', { name: /Annotations/ }).click();
  await page.locator('.sr-annotations-panel [data-annotation-id="demo-question"] .sr-thread-location').click();
  await expect(page.getByRole('checkbox', { name: 'Hide viewed files', exact: true })).not.toBeChecked();
  await expect(page.getByRole('searchbox', { name: 'Filter changed files', exact: true })).toHaveValue('');
  await expect(page.locator('[data-file-path]')).toHaveCount(1);
  await expect(file.locator('.sr-code').first()).toBeVisible();
  await expect(file.locator('[data-annotation-id="demo-question"]')).toBeInViewport();
  await expect(page.getByRole('checkbox', { name: 'Mark src/capture.ts as reviewed', exact: true })).toBeChecked();
});

test('inline changed regions preserve code and line-number range selection saves an old-side anchor', async ({ page }) => {
  await openCapture(page);
  const path = 'src/capture/format.ts';
  const file = page.locator(`[data-file-path="${path}"]`);
  const source = await page.evaluate(async path => {
    const host = window.__demoHost;
    const repository = (await host.listRepositories())[0];
    const stash = (await host.listStashes())[0];
    const file = (await host.getDiff(repository, stash, 'all', 3)).find(file => file.path === path)!;
    return { old: file.oldContent!.split('\n')[1], next: file.newContent!.split('\n')[1] };
  }, path);
  const before = file.locator('.sr-line-delete .sr-code');
  const after = file.locator('.sr-line-add .sr-code');
  expect(await before.innerText()).toBe(source.old);
  expect(await after.innerText()).toBe(source.next);
  expect(await after.locator('.sr-inline-change').count()).toBeGreaterThan(0);
  await file.getByRole('button', { name: 'Select old line 1', exact: true }).click();
  await file.getByRole('button', { name: 'Select old line 3', exact: true }).click({ modifiers: ['Shift'] });
  await expect(file.getByText('Old lines 1–3', { exact: true })).toBeVisible();
  await expect(file.locator('.sr-line-selected')).toHaveCount(3);
  await file.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Keep the original format readable while normalizing new captures.');
  await file.getByRole('button', { name: 'Save annotation', exact: true }).click();
  const note = await page.evaluate(() => window.__demoHost.getMetadata('demo-fieldbook', '8d7be6a901afe7794ed9a6f1a3cb0318409876da').annotations.find(note => note.path === 'src/capture/format.ts'));
  expect(note).toMatchObject({ path, side: 'old', startLine: 1, endLine: 3, layer: 'all' });
  await page.getByRole('button', { name: 'Split diff', exact: true }).click();
  await expect(file.getByText('Keep the original format readable while normalizing new captures.', { exact: true })).toBeVisible();
});

test('collapsing files preserves an unsaved annotation until it is cancelled', async ({ page }) => {
  await openCapture(page);
  const file = page.locator('[data-file-path="src/capture.ts"]');
  await file.getByRole('button', { name: 'Select new line 20', exact: true }).click();
  const composer = file.getByRole('textbox', { name: 'Annotation text', exact: true });
  await composer.fill('Do not lose this draft while scanning headers.');
  await page.getByRole('button', { name: 'Collapse all files', exact: true }).click();
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue('Do not lose this draft while scanning headers.');
  await expect(file.getByRole('button', { name: 'Collapse diff for src/capture.ts', exact: true })).toBeDisabled();
  await file.getByRole('button', { name: 'Cancel annotation', exact: true }).click();
  await expect(file.locator('.sr-code')).toHaveCount(0);
  await file.getByRole('button', { name: 'Expand diff for src/capture.ts', exact: true }).click();
  await expect(file.locator('.sr-code').first()).toBeVisible();
});
