import {expect, test, type Page} from '@playwright/test';
import {BenchmarkHost, fixtureMetadata} from '../../scripts/benchmark-fixtures';

async function largeReview(page: Page, scenario: 'many-files' | 'dense-large-file') {
  const fixture = new BenchmarkHost(scenario);
  const payload = {repository: fixture.repository, stashes: fixture.stashes, files: fixture.files, metadata: fixture.getMetadata(fixture.repository.id, fixture.stashes[0].hash)};
  if (scenario === 'dense-large-file') payload.metadata.annotations.push({...fixtureMetadata(fixture.files, 1).annotations[0], id: 'distant-note', startLine: 5000, endLine: 5000, resolved: false});
  await page.addInitScript(payload => {
    let connected: Window['__demoHost'];
    Object.defineProperty(window, '__demoHost', {
      configurable: true, get: () => connected,
      set(host: Window['__demoHost']) {
        connected = host;
        const sources = new Map(payload.files.map(file => [file.path, file]));
        host.listRepositories = async () => [payload.repository];
        host.listStashes = async () => payload.stashes;
        host.getDiff = async () => payload.files.map(({oldContent: _old, newContent: _next, ...file}) => file);
        host.getFileContents = async (_repository, _stash, file) => ({oldContent: sources.get(file.path)!.oldContent!, newContent: sources.get(file.path)!.newContent!});
        host.getMetadata = () => structuredClone(payload.metadata);
        host.saveMetadata = async (_repository, _hash, metadata) => {payload.metadata = structuredClone(metadata);};
      }
    });
  }, payload);
  await page.goto('/');
  await expect(page.locator('[data-file-path="' + fixture.files[0].path + '"] .sr-code').first()).toBeVisible();
  return fixture;
}

test('a thousand files render nearby code and reveal a distant file on navigation', async ({page}) => {
  const fixture = await largeReview(page, 'many-files');
  expect(await page.locator('.sr-diff-row').count()).toBeLessThan(500);
  const last = fixture.files.at(-1)!;
  await page.locator('[data-tree-path="' + last.path + '"]').click();
  await expect(page.locator('[data-file-path="' + last.path + '"] .sr-code').first()).toBeVisible();
  await expect(page.getByRole('region', {name: 'Code diff', exact: true})).toBeVisible();
});

test('annotation navigation reveals a deferred distant line even with another line selected', async ({page}) => {
  await largeReview(page, 'dense-large-file');
  await page.getByRole('button', {name: 'Annotate new line 2', exact: true}).click();
  await page.getByRole('tab', {name: /Annotations/}).click();
  await page.locator('[data-annotation-id="distant-note"] .sr-thread-location').click();
  await expect(page.locator('.sr-diff-scroll [data-annotation-id="distant-note"]')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Annotate new line 5000', exact: true})).toBeVisible();
});

test('large diffs defer rows without losing drafts or selected code across unloaded rows', async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = await largeReview(page, 'dense-large-file');
  expect(await page.locator('.sr-diff-row').count()).toBeLessThan(1000);
  await page.getByRole('button', {name: 'Annotate new line 2', exact: true}).click();
  await page.getByRole('textbox', {name: 'Annotation text', exact: true}).fill('Keep my draft while scrolling through a large diff');
  await page.locator('.sr-diff-scroll').evaluate(element => {element.scrollTop = element.scrollHeight;});
  await expect(page.getByRole('button', {name: 'Annotate new line 5000', exact: true})).toBeVisible();
  await expect(page.getByRole('textbox', {name: 'Annotation text', exact: true})).toHaveValue('Keep my draft while scrolling through a large diff');
  await page.getByRole('button', {name: 'Cancel annotation', exact: true}).click();
  await page.evaluate(() => {
    const codes = document.querySelectorAll('.sr-code');
    const range = document.createRange();
    range.setStartBefore(codes[0]); range.setEndAfter(codes[codes.length - 1]);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await page.keyboard.press('ControlOrMeta+c');
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
  const expected = fixture.files[0].hunks[0].lines.map(line => line.text).join('\n');
  expect(copied).toBe(expected);
});

test('split selections include unloaded rows from only the selected side', async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = await largeReview(page, 'dense-large-file');
  await page.getByRole('button', {name: 'Split diff', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Annotate new line 2', exact: true})).toBeVisible();
  expect(await page.locator('.sr-split-row').count()).toBeLessThan(1000);
  await page.locator('.sr-diff-scroll').evaluate(element => {element.scrollTop = element.scrollHeight;});
  await expect(page.getByRole('button', {name: 'Annotate new line 5000', exact: true})).toBeVisible();
  await page.evaluate(() => {
    const codes = document.querySelectorAll('.sr-code[data-side="new"]');
    const range = document.createRange();
    range.setStart(codes[0], 0); range.setEnd(codes[codes.length - 1], codes[codes.length - 1].childNodes.length);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await page.keyboard.press('ControlOrMeta+c');
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
  expect(copied).toBe(fixture.files[0].newContent!.trimEnd());
});

test('visited row groups dispatch annotation changes to the current review', async ({page}) => {
  await largeReview(page, 'dense-large-file');
  await page.evaluate(async () => {
    for (let group = 0; group < 120; group++) {
      const pending = document.querySelector<HTMLElement>('.sr-diff-code .sr-deferred-placeholder');
      if (!pending) return;
      pending.parentElement!.scrollIntoView({block: 'center', behavior: 'instant'});
      for (let frame = 0; pending.isConnected && frame < 120; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
      if (pending.isConnected) throw new Error('Visible row group did not render');
    }
  });
  expect(await page.locator('.sr-diff-code .sr-deferred-placeholder').count()).toBe(0);
  await page.getByRole('button', {name: 'Annotate new line 5000', exact: true}).click();
  await page.getByRole('textbox', {name: 'Annotation text', exact: true}).fill('A note after visiting every row');
  await page.getByRole('button', {name: 'Save annotation', exact: true}).click();
  const thread = page.locator('.sr-diff-scroll .sr-thread').filter({hasText: 'A note after visiting every row'});
  await expect(thread).toBeVisible();
  const id = await thread.getAttribute('data-annotation-id');
  const saved = page.locator(`.sr-diff-scroll [data-annotation-id="${id}"]`);
  await saved.getByRole('button', {name: 'Annotation actions', exact: true}).click();
  await saved.getByRole('button', {name: 'Edit annotation', exact: true}).click();
  await saved.getByRole('textbox', {name: 'Edit annotation text', exact: true}).fill('Updated note after visiting every row');
  await saved.getByRole('button', {name: 'Save changes', exact: true}).click();
  await expect(saved.getByText('Updated note after visiting every row', {exact: true})).toBeVisible();
  await saved.getByRole('button', {name: 'Resolve thread', exact: true}).click();
  await expect(saved.getByText('Resolved', {exact: true})).toBeVisible();
});
