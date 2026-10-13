import {expect, test} from '@playwright/test';

const captureHash = '8d7be6a901afe7794ed9a6f1a3cb0318409876da';

test('short laptop panels leave useful space for code and details can be expanded', async ({page}, testInfo) => {
  await page.setViewportSize({width: 1024, height: 640});
  await page.goto('/');
  await expect(page.locator('[data-file-path="src/capture.ts"]')).toBeVisible();
  const diff = page.getByRole('region', {name: 'Code diff', exact: true});
  const bounds = await diff.boundingBox();
  expect(bounds!.width).toBeGreaterThan(700);
  expect(bounds!.height).toBeGreaterThan(300);
  await expect(page.locator('.sr-review-description')).toBeHidden();
  await page.getByRole('button', {name: 'Show stash details', exact: true}).click();
  await expect(page.locator('.sr-review-description')).toBeVisible();
  await page.getByRole('button', {name: 'Hide stash details', exact: true}).click();
  await page.getByRole('button', {name: 'Toggle file navigator', exact: true}).click();
  await expect(page.getByRole('tree', {name: 'Changed files', exact: true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', {name: 'Toggle file navigator', exact: true})).toBeFocused();
  await expect(page.getByRole('tree', {name: 'Changed files', exact: true})).toBeHidden();
  await page.getByRole('button', {name: 'Wrap code lines', exact: true}).click();
  await expect(page.locator('.sr-app')).toHaveClass(/sr-wrap-code/);
  await page.screenshot({path: testInfo.outputPath('laptop-compact.png')});
});

test('code remains selectable under Obsidian chrome and copying excludes the diff gutters', async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const file = page.locator('[data-file-path="src/capture.ts"]');
  await expect(file).toBeVisible();
  await page.addStyleTag({content: '.sr-app { user-select: none; }'});
  const code = file.locator('.sr-code').first();
  await code.locator('.hljs-keyword').first().dblclick();
  expect(await page.evaluate(() => getSelection()?.toString().trim())).toBe('import');
  await page.evaluate(() => {
    const codes = document.querySelectorAll('[data-file-path="src/capture.ts"] .sr-code');
    const range = document.createRange();
    range.setStartBefore(codes[0]); range.setEndAfter(codes[1]);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await page.keyboard.press('ControlOrMeta+c');
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe("import { App, TFile } from 'obsidian';\nimport { CaptureSettings } from './settings';");
  await file.getByRole('button', {name: 'Copy stashed code for src/capture.ts', exact: true}).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('async open(result: CaptureResult)');
});

test('Markdown actions copy an immutable link and a usable embed block', async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', {name: 'More stash actions', exact: true}).click();
  await page.getByRole('button', {name: 'Copy Markdown link', exact: true}).click();
  const markdown = await page.evaluate(() => navigator.clipboard.readText());
  expect(markdown).toContain('[Ambient note capture](obsidian://stash-review?');
  expect(markdown).toContain('stash=' + captureHash);
  expect(markdown).not.toContain('stash%40');
  await page.getByRole('button', {name: 'More stash actions', exact: true}).click();
  await page.getByRole('button', {name: 'Copy Markdown embed', exact: true}).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toMatch(/^```stash-review\nobsidian:\/\/stash-review\?.*\n```$/);
});

test('a Markdown embed opens the requested snapshot and retains annotations', async ({page}, testInfo) => {
  await page.goto(`/?embed=1&repo=demo-fieldbook&stash=${captureHash}&file=src/paths.ts&layer=staged`);
  const file = page.locator('[data-file-path="src/paths.ts"]');
  await expect(file).toBeVisible();
  await expect(page.locator('[data-file-path]')).toHaveCount(1);
  await expect(page.getByRole('button', {name: 'Staged', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await file.getByRole('button', {name: 'Annotate new line 1', exact: true}).click();
  await file.getByRole('textbox', {name: 'Annotation text', exact: true}).fill('Saved from a Markdown note');
  await file.getByRole('button', {name: 'Save annotation', exact: true}).click();
  await page.reload();
  await expect(file.getByText('Saved from a Markdown note', {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Open full review', exact: true})).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('markdown-embed.png')});
});

test('a missing linked stash is explained without opening an unrelated stash', async ({page}) => {
  await page.goto('/?repo=demo-fieldbook&stash=' + 'a'.repeat(40));
  await expect(page.getByRole('heading', {name: 'Linked stash unavailable', exact: true})).toBeVisible();
  await expect(page.locator('[data-file-path]')).toHaveCount(0);
});

test('two embeds of the same stash share saved notes and have separate collapse controls', async ({page}) => {
  await page.goto(`/?embed=2&repo=demo-fieldbook&stash=${captureHash}&file=src/paths.ts&layer=staged`);
  const reviews = page.locator('.sr-app');
  await expect(reviews).toHaveCount(2);
  await reviews.first().getByRole('button', {name: 'Annotate new line 1', exact: true}).click();
  await reviews.first().getByRole('textbox', {name: 'Annotation text', exact: true}).fill('Shared across Markdown embeds');
  await reviews.first().getByRole('button', {name: 'Save annotation', exact: true}).click();
  await expect(reviews.nth(1).getByText('Shared across Markdown embeds', {exact: true})).toBeVisible();
  const ids = await page.locator('[id]').evaluateAll(elements => elements.map(element => element.id));
  expect(new Set(ids).size).toBe(ids.length);
  const collapse = reviews.first().getByRole('button', {name: 'Collapse diff for src/paths.ts', exact: true});
  const controlledId = await collapse.getAttribute('aria-controls');
  await expect(reviews.first().locator(`[id="${controlledId}"]`)).toHaveCount(1);
  await collapse.click();
  await expect(reviews.first().locator('.sr-code')).toHaveCount(0);
  await expect(reviews.nth(1).locator('.sr-code').first()).toBeVisible();
});

test('copying a vertical split selection keeps only that side of the diff', async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', {name: 'Split diff', exact: true}).click();
  await page.locator('[data-file-path="src/capture.ts"] .sr-code').first().click();
  await page.evaluate(() => {
    const codes = document.querySelectorAll('[data-file-path="src/capture.ts"] .sr-code[data-side="new"]');
    const range = document.createRange();
    range.setStart(codes[0], 0); range.setEnd(codes[1], codes[1].childNodes.length);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await page.keyboard.press('ControlOrMeta+c');
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe("import { App, TFile } from 'obsidian';\nimport { CaptureSettings } from './settings';");
});

test('a missing linked file does not silently select another path', async ({page}) => {
  await page.goto(`/?embed=1&repo=demo-fieldbook&stash=${captureHash}&file=missing.ts`);
  await expect(page.getByRole('heading', {name: 'Linked file unavailable', exact: true})).toBeVisible();
  await expect(page.locator('[data-file-path]')).toHaveCount(0);
  await page.getByRole('button', {name: 'All files', exact: true}).click();
  await expect(page.locator('[data-file-path="src/capture.ts"]')).toBeVisible();
});

test('independent edits in two embeds survive while their disk writes are pending', async ({page}) => {
  await page.goto(`/?embed=2&repo=demo-fieldbook&stash=${captureHash}&file=src/paths.ts&layer=staged`);
  const reviews = page.locator('.sr-app');
  await expect(reviews.first().locator('[data-file-path="src/paths.ts"]')).toBeVisible();
  await page.evaluate(() => {
    const state = window as typeof window & {__finishWrites: Array<() => void>};
    state.__finishWrites = [];
    const save = window.__demoHost.saveMetadata.bind(window.__demoHost);
    window.__demoHost.saveMetadata = async (...args) => {
      await save(...args);
      await new Promise<void>(resolve => state.__finishWrites.push(resolve));
    };
  });
  await reviews.first().getByRole('button', {name: 'Pin stash', exact: true}).click();
  await reviews.nth(1).getByRole('checkbox', {name: 'Mark src/paths.ts as reviewed', exact: true}).check();
  await page.evaluate(() => (window as typeof window & {__finishWrites: Array<() => void>}).__finishWrites.splice(0).forEach(finish => finish()));
  await expect(reviews.first().getByRole('checkbox', {name: 'Mark src/paths.ts as reviewed', exact: true})).toBeChecked();
  await expect(reviews.nth(1).getByRole('button', {name: 'Unpin stash', exact: true})).toBeVisible();
  const metadata = await page.evaluate(() => window.__demoHost.getMetadata('demo-fieldbook', '8d7be6a901afe7794ed9a6f1a3cb0318409876da'));
  expect(metadata.pinned).toBe(true);
  expect(metadata.reviewedByLayer?.staged).toContain('src/paths.ts');
});

test('retargeting an open review hides the old stash until the linked repository is resolved', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('[data-file-path="src/capture.ts"]')).toBeVisible();
  await page.evaluate(async () => {
    const repositories = await window.__demoHost.listRepositories();
    const second = {...repositories[0], id: 'second-repo', path: '/Demo vault/second', name: 'second'};
    const state = window as typeof window & {__resolveRepositories: () => void};
    window.__demoHost.listRepositories = () => new Promise(resolve => {state.__resolveRepositories = () => resolve([...repositories, second]);});
    await window.__demoHost.openReview({repositoryId: 'second-repo', stashHash: '8d7be6a901afe7794ed9a6f1a3cb0318409876da'});
  });
  await expect(page.getByRole('button', {name: 'Apply stash', exact: true})).toHaveCount(0);
  await expect(page.locator('[data-file-path]')).toHaveCount(0);
  await page.evaluate(() => (window as typeof window & {__resolveRepositories: () => void}).__resolveRepositories());
  await expect(page.locator('.sr-topbar-project')).toHaveText('second');
  await expect(page.locator('[data-file-path="src/capture.ts"]')).toBeVisible();
});
