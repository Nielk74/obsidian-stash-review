import {expect, test} from '@playwright/test';
import {BenchmarkHost, fixtureMetadata} from '../../scripts/benchmark-fixtures';

test('a dropped review remains readable and recoverable after reload', async ({page}) => {
  await page.goto('/');
  const hash = await page.evaluate(() => window.__demoHost.listStashes(window.__demoHost['repository']()).then(stashes => stashes[0].hash));
  await page.getByRole('button', {name:'More stash actions'}).click();
  await page.getByRole('button', {name:'Drop stash',exact:true}).click();
  await page.getByRole('dialog').getByRole('button', {name:'Drop stash',exact:true}).click();
  await page.reload();
  await page.getByRole('button', {name:'Archived reviews',exact:true}).click();
  await expect(page.locator('.sr-code').first()).toBeVisible();
  await page.getByRole('button', {name:'More stash actions'}).click();
  await page.getByRole('button', {name:'Restore stash',exact:true}).click();
  await expect.poll(() => page.evaluate(() => window.__demoHost.operations.at(-1)?.name)).toBe('restore');
  await page.getByRole('button', {name:'Active stashes',exact:true}).click();
  await expect(page.locator('.sr-stash-card')).toHaveCount(6);
  await expect.poll(() => page.evaluate(hash => window.__demoHost.listStashes(window.__demoHost['repository']()).then(stashes => stashes.some(stash => stash.hash===hash)),hash)).toBe(true);
});

test('viewed progress is independent for staged, unstaged and All changes', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button',{name:'Staged',exact:true}).click();
  const viewed = page.getByRole('checkbox',{name:/Mark .* as reviewed/}).first();
  await viewed.check();
  await page.getByRole('button',{name:'Unstaged',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:/Mark .* as reviewed/}).first()).not.toBeChecked();
  await page.getByRole('button',{name:'All changes',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:/Mark .* as reviewed/}).first()).not.toBeChecked();
  await page.getByRole('button',{name:'Staged',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:/Mark .* as reviewed/}).first()).toBeChecked();
});

test('content search preserves original coordinates and finds annotation replies', async ({page}) => {
  await page.goto('/');
  await page.getByRole('searchbox',{name:'Find in changes'}).fill('export');
  await expect(page.locator('.sr-search-match').first()).toBeVisible();
  await expect(page.locator('.sr-change-search-count')).not.toHaveText('0 matches');
  await page.getByRole('button',{name:'Next change match'}).click();
  await expect(page.locator('.sr-code .sr-search-match').first()).toBeVisible();
  await page.getByRole('tab',{name:/Annotations/}).click();
  await page.getByRole('searchbox',{name:'Search annotations'}).fill('unlikely-to-exist-123');
  await expect(page.getByText('No matching threads')).toBeVisible();
});

test('portable data imported into a saved repository opens offline without Git actions', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('.sr-code').first()).toBeVisible();
  const target = await page.evaluate(async () => {
    const host=window.__demoHost, repo=(await host.listRepositories())[0], stash=(await host.listStashes(repo))[0];
    const pkg=JSON.parse(await host.exportReviewData!(repo,stash));
    pkg.repository={id:'offline-package',name:'Saved package'};
    return host.importReviewData!(JSON.stringify(pkg));
  });
  await page.goto(`/?repo=${target.repositoryId}&stash=${target.stashHash}`);
  await expect(page.locator('.sr-code').first()).toBeVisible();
  await expect(page.getByRole('button',{name:'Apply stash',exact:true})).toBeDisabled();
  await expect(page.getByText('Saved review · repository offline')).toBeVisible();
  expect(await page.evaluate(() => window.__demoHost.operations)).toEqual([]);
});

test('Markdown descriptions render links and fences without interpreting HTML', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button',{name:'Edit details',exact:true}).click();
  await page.getByRole('textbox',{name:'Stash description'}).fill('See [[Project notes]]\n\n```ts\n<script>unsafe()</script>\n```');
  await page.getByRole('button',{name:'Save details',exact:true}).click();
  await expect(page.locator('.sr-review-description').getByRole('link',{name:'Project notes'})).toBeVisible();
  await expect(page.locator('.sr-review-description pre')).toContainText('<script>unsafe()</script>');
  expect(await page.locator('.sr-review-description script').count()).toBe(0);
});

test('archive actions keep the Git stash and paginated browsing does not read other diffs', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('.sr-code').first()).toBeVisible();
  await page.getByRole('button',{name:'More stash actions'}).click();
  await page.getByRole('button',{name:'Archive review',exact:true}).click();
  await page.getByRole('button',{name:'Archived reviews',exact:true}).click();
  await expect(page.locator('.sr-stash-card')).toHaveCount(1);
  expect(await page.evaluate(() => window.__demoHost.operations)).toEqual([]);
  await page.getByRole('button',{name:'More stash actions'}).click();
  await page.getByRole('button',{name:'Restore to Active',exact:true}).click();
  await page.getByRole('button',{name:'Active stashes',exact:true}).click();
  await expect(page.locator('.sr-stash-card')).toHaveCount(6);
});

test('archive pagination reads code only for the selected review', async ({page}) => {
  const fixture=new BenchmarkHost('many-stashes');
  await page.addInitScript(payload=>{
    let connected:Window['__demoHost'];
    Object.defineProperty(window,'__demoHost',{configurable:true,get:()=>connected,set(host:Window['__demoHost']){
      connected=host;host.listRepositories=async()=>[payload.repository];host.listStashes=async()=>[];
      host.listArchivedReviews=async()=>payload.stashes.map(stash=>({...stash,archived:true,inStashList:false,recoverable:false}));
      host.getDiff=async()=>{(window as unknown as {diffReads:number}).diffReads=((window as unknown as {diffReads:number}).diffReads ?? 0)+1;return payload.files;};
    }});
  },{repository:fixture.repository,stashes:fixture.stashes.slice(0,120),files:fixture.files});
  await page.goto('/');await page.getByRole('button',{name:'Archived reviews',exact:true}).click();
  await expect(page.locator('.sr-stash-card')).toHaveCount(50);
  await expect(page.locator('.sr-code').first()).toBeVisible();
  await page.getByRole('button',{name:'Next archive page'}).click();
  await expect(page.locator('.sr-stash-card')).toHaveCount(50);
  expect(await page.evaluate(()=>(window as unknown as {diffReads:number}).diffReads)).toBe(1);
  await page.locator('.sr-stash-card').first().click();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {diffReads:number}).diffReads)).toBe(2);
  await page.getByRole('searchbox',{name:'Search stashes'}).fill('Saved work 119');
  await expect(page.locator('.sr-stash-card')).toHaveCount(1);
});

test('change search reveals a distant chunk and noise filtering preserves comment anchors', async ({page}) => {
  const fixture=new BenchmarkHost('dense-large-file'), metadata=fixtureMetadata(fixture.files,1);
  metadata.annotations[0]={...metadata.annotations[0],resolved:false,startLine:5000,endLine:5000};
  await page.addInitScript(payload=>{
    let connected:Window['__demoHost'];
    Object.defineProperty(window,'__demoHost',{configurable:true,get:()=>connected,set(host:Window['__demoHost']){
      connected=host;host.listRepositories=async()=>[payload.repository];host.listStashes=async()=>payload.stashes;
      host.getDiff=async()=>payload.files;host.getMetadata=()=>structuredClone(payload.metadata);
    }});
  },{repository:fixture.repository,stashes:[fixture.stashes[0]],files:fixture.files,metadata});
  await page.goto('/');
  await page.getByRole('searchbox',{name:'Find in changes'}).fill('value_0_4999');
  await expect(page.locator('.sr-change-search-count')).toHaveText('1/2');
  await page.getByRole('button',{name:'Next change match'}).click();
  await expect(page.locator('.sr-code[data-side="old"][data-line-number="5000"] .sr-search-match')).toBeVisible();
  await page.getByRole('checkbox',{name:'Ignore whitespace changes'}).check();
  await page.getByRole('tab',{name:/Annotations/}).click();
  await page.getByRole('searchbox',{name:'Search annotations'}).fill('original snapshot');
  await expect(page.locator('.sr-annotations-panel [data-annotation-id="note-0"]')).toBeVisible();
  await page.locator('.sr-annotations-panel .sr-thread-location').click();
  await expect(page.getByRole('checkbox',{name:'Ignore whitespace changes'})).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Annotate new line 5000',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.__demoHost.operations)).toEqual([]);
});

test('a replacement review uses an explicitly selected original and preserves its notes', async ({page}) => {
  await page.goto('/');await expect(page.locator('.sr-code').first()).toBeVisible();
  const previous=await page.evaluate(async()=>{const host=window.__demoHost,repo=(await host.listRepositories())[0],stash=(await host.listStashes(repo))[0];await host.archiveReview(repo,stash,true);await host.createStash(repo,'Replacement idea',true);return stash.hash;});
  await page.getByRole('button',{name:'Refresh stashes'}).click();
  await page.locator('.sr-stash-card').first().click();
  await page.getByRole('button',{name:'More stash actions'}).click();
  await page.getByRole('button',{name:'Continue from previous review'}).click();
  await page.getByRole('combobox',{name:'Original review'}).selectOption(previous);
  await page.getByRole('button',{name:'Continue review',exact:true}).click();
  await expect(page.getByText('Continued from '+previous.slice(0,8),{exact:false})).toBeVisible();
  await page.getByRole('tab',{name:/Annotations/}).click();
  await expect(page.getByText('Should captures with the same title always append?',{exact:false})).toBeVisible();
  const original=await page.evaluate(hash=>window.__demoHost.getMetadata('demo-fieldbook',hash),previous);
  expect(original.annotations).toHaveLength(1);
});

test('large diffs index text only when search starts and reuse the index while typing', async ({page}) => {
  const fixture=new BenchmarkHost('dense-large-file');
  await page.addInitScript(payload=>{
    let connected:Window['__demoHost'];
    const state=window as unknown as {diffTextReads:number};state.diffTextReads=0;
    Object.defineProperty(window,'__demoHost',{configurable:true,get:()=>connected,set(host:Window['__demoHost']){
      connected=host;host.listRepositories=async()=>[payload.repository];host.listStashes=async()=>payload.stashes;
      for(const file of payload.files)for(const hunk of file.hunks)for(const line of hunk.lines){const text=line.text;Object.defineProperty(line,'text',{get(){state.diffTextReads++;return text;}});}
      host.getDiff=async()=>payload.files;
    }});
  },{repository:fixture.repository,stashes:[fixture.stashes[0]],files:fixture.files});
  await page.goto('/');await expect(page.locator('.sr-code').first()).toBeVisible();
  const reads=()=>page.evaluate(()=>(window as unknown as {diffTextReads:number}).diffTextReads);
  expect(await reads()).toBeLessThan(20000);
  await page.getByRole('searchbox',{name:'Find in changes'}).fill('before');
  await expect(page.locator('.sr-change-search-count')).toHaveText('1/5000');
  const indexed=await reads();expect(indexed).toBeGreaterThan(30000);
  await page.getByRole('searchbox',{name:'Find in changes'}).fill('after');
  await expect(page.locator('.sr-search-match').first()).toHaveText('after');
  expect((await reads())-indexed).toBeLessThan(15000);
});
