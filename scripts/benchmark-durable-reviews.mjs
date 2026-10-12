// Focused durable-review audit. Uses synthetic data and a production React bundle.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {cpus,platform,release} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const root=resolve(import.meta.dirname,'..'), args=process.argv.slice(2);
const option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const samples=Math.max(5,Number(option('--samples','5'))), output=resolve(root,option('--output','benchmarks/results/durable-focused.json'));
if(args.includes('--compare-existing')) {
  const source=await readFile(join(root,'scripts/benchmark.mjs'),'utf8');
  assert.ok(source.includes('count: 3') && source.includes("scenario === 'dense-large-file' || scenario === 'many-files' || scenario === 'many-notes' ? 3 : 5"),'The supplied runner caps changed; inspect it before adapting sample counts.');
  const adapted=source.replace('count: 3','count: samples').replace("const startups = Math.min(samples, scenario === 'dense-large-file' || scenario === 'many-files' || scenario === 'many-notes' ? 3 : 5);",'const startups = samples;')
    .replace("document.querySelectorAll('.sr-app').length === 6 && document.querySelector('.sr-code')","document.querySelectorAll('.sr-app').length === 6 && Boolean(document.querySelector('.sr-code'))");
  const temporary=join(root,'scripts',`.durable-benchmark-${process.pid}-${Date.now()}.mjs`);
  assert.equal(dirname(temporary),join(root,'scripts'));
  try {await writeFile(temporary,adapted,'utf8');execFileSync(process.execPath,['--expose-gc',temporary,...args.filter(argument=>argument!=='--compare-existing')],{cwd:root,stdio:'inherit',windowsHide:true});}
  finally {await unlink(temporary);}
  process.exit(0);
}
const bundle=async configuration=>(await build({bundle:true,write:false,minify:true,target:'es2022',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},...configuration})).outputFiles[0].text;
const moduleSource=await bundle({stdin:{contents:["export * from './src/review-library';","export * from './src/review-portability';","export * from './src/review-store';","export * from './src/types';","export * from './src/ui/change-search';","export * from './scripts/benchmark-fixtures';"].join('\n'),resolveDir:root,loader:'ts'},format:'esm',platform:'node'});
const api=await import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));
const report={schemaVersion:1,source:{commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),computeBundleSha256:createHash('sha256').update(moduleSource).digest('hex')},environment:{node:process.version,os:platform()+' '+release(),cpu:cpus()[0]?.model,explicitGC:typeof global.gc==='function'},methodology:{samples,statistics:'Median and nearest-rank p95; raw samples retained.',browser:'Production React, synthetic host, two animation frames. Search separately reports total latency and latency excluding its deliberate 100 ms debounce.',native:'Library workloads use in-memory snapshot storage; real Git, compression and disk writes are measured by the supplied benchmark runner.'},metrics:[],browserErrors:[],memory:[],assertions:[]};
await mkdir(dirname(output),{recursive:true});
const checkpoint=()=>writeFile(output,JSON.stringify(report,null,2)+'\n','utf8');
async function record(name,values,targetMs,details={}) {
  const sorted=[...values].sort((a,b)=>a-b), round=value=>+value.toFixed(3);
  const metric={name,samples:values.length,medianMs:round(sorted.length%2?sorted[Math.floor(sorted.length/2)]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2),p95Ms:round(sorted[Math.ceil(sorted.length*.95)-1]),rawMs:values.map(round),targetMs,...details};
  metric.withinTarget=metric.p95Ms<=targetMs;report.metrics.push(metric);
  process.stdout.write(`${name}: median ${metric.medianMs} ms; p95 ${metric.p95Ms} ms${metric.withinTarget?'':' [over target]'}\n`);await checkpoint();
}
async function measure(name,operation,targetMs,batch=1) {
  await operation(-1);const values=[];
  for(let sample=0;sample<samples;sample++){const start=performance.now();for(let index=0;index<batch;index++)await operation(sample*batch+index);values.push((performance.now()-start)/batch);}
  await record(name,values,targetMs);
}
const repository={id:'bench-repo',name:'Review fixture',path:'C:/fixture',branch:'main',dirty:false};
const stash={hash:'a'.repeat(40),baseHash:'b'.repeat(40),ref:'stash@{0}',message:'Saved idea',branch:'main',createdAt:'2026-10-12T08:00:00Z'};
function filesFor(count) {
  return Array.from({length:count},(_,index)=>{const file=api.fixtureFile(index,20,3);Object.assign(file,{oldMode:'100644',newMode:'100644',oldBlob:'b'.repeat(40),newBlob:'c'.repeat(40)});file.fingerprint=api.fileFingerprint(file);return file;});
}
function libraryFixture(files=filesFor(12)) {
  let data=api.loadPluginData({settings:{repositories:[repository.path]},repositoryCatalog:{[repository.id]:{id:repository.id,name:repository.name,paths:[repository.path]}}});
  const counts={diff:0,source:0,snapshotReads:0,snapshotWrites:0}, snapshots=new Map();
  const writes=new api.DataTransactions(()=>data,next=>{data=next;},async()=>{});
  const git={resolveRepository:async path=>({...repository,path,id:'physical-id'}),listStashes:async()=>[stash],retainStash:async()=>{},listRetainedStashes:async()=>[stash],getDiff:async()=>{counts.diff++;return structuredClone(files);},getFileContents:async(_repo,_stash,file)=>{counts.source++;return {oldContent:file.oldContent??'',newContent:file.newContent??''};}};
  const library=new api.ReviewLibrary({getData:()=>data,transaction:change=>writes.transaction(change),storage:{read:async(id,hash,layer)=>{counts.snapshotReads++;return structuredClone(snapshots.get(JSON.stringify([id,hash,layer])));},write:async(id,hash,layer,snapshot)=>{counts.snapshotWrites++;snapshots.set(JSON.stringify([id,hash,layer]),structuredClone(snapshot));},remove:async(id,hash,layer)=>{snapshots.delete(JSON.stringify([id,hash,layer]));}}},git);
  return {library,writes,counts,data:()=>data};
}
for(const count of [1000,5000]) {
  const files=filesFor(count), index=api.indexChanges(files);
  assert.equal(api.findChanges(index,'value_999_').length,9);
  await measure(`search.index.${count}`,()=>api.indexChanges(files),30,5);
  await measure(`search.literal.${count}`,()=>api.findChanges(index,'before'),30,10);
  await measure(`noise.presentation.${count}`,()=>files.map(file=>file.hunks.map(hunk=>api.whitespacePresentation(hunk.lines))),30,5);
}
const progress={...api.emptyMetadata(),reviewedByLayer:{all:['all.ts'],staged:['index.ts'],unstaged:['work.ts']}};
await measure('progress.layer-lookup.1000',()=>{for(let index=0;index<1000;index++)assert.equal(api.reviewedPaths(progress,['all','staged','unstaged'][index%3]).length,1);},30,20);
await measure('library.six-identical-reads',async()=>{
  const fixture=libraryFixture();const snapshots=await Promise.all(Array.from({length:6},()=>fixture.library.getDiff(repository,stash,'all',5)));
  assert.equal(fixture.counts.diff,1);assert.equal(fixture.counts.snapshotWrites,1);assert.equal(snapshots[0],snapshots[5]);
},100);
report.assertions.push('Six identical immutable readers perform one diff read and one snapshot write.');
const archiveFixture=libraryFixture();
archiveFixture.data().reviewCatalog[repository.id]={};archiveFixture.data().reviews[repository.id]={};
for(let index=1;index<=1000;index++){const hash=index.toString(16).padStart(40,'0');archiveFixture.data().reviewCatalog[repository.id][hash]={stash:{...stash,hash},archived:true,snapshotLayers:[],fingerprints:{}};archiveFixture.data().reviews[repository.id][hash]=api.fixtureMetadata(filesFor(1),10);}
await measure('archive.descriptors.1000',async()=>{const archives=await archiveFixture.library.listArchivedReviews(repository);assert.equal(archives.length,1000);assert.equal(archiveFixture.counts.snapshotReads,0);},30);
await measure('archive.summaries.1000',()=>Object.keys(archiveFixture.data().reviews[repository.id]).map(hash=>api.reviewSummary(archiveFixture.data(),repository.id,hash)),30,5);
report.assertions.push('Archive descriptor and summary browsing reads no snapshot contents.');
await measure('repository.relocation',async()=>{const fixture=libraryFixture();await fixture.library.relocateRepository(repository.id,'C:/moved');assert.equal(fixture.data().repositoryCatalog[repository.id].id,repository.id);},100);
await measure('revision.continuation.1000-files',async()=>{
  const fixture=libraryFixture(filesFor(1000));await fixture.library.getDiff(repository,stash,'all',5);await fixture.writes.saveMetadata(repository.id,stash.hash,api.fixtureMetadata(filesFor(12),10));
  const revised={...stash,hash:'d'.repeat(40)};await fixture.library.continueReview(repository,revised,stash.hash);assert.equal(api.readMetadata(fixture.data(),repository.id,revised.hash).annotations.length,10);
},1000);
const portableFixture=libraryFixture(), portable=await portableFixture.library.exportReviewData(repository,stash);
await measure('portable.parse.typical',()=>api.parsePortableReview(portable),30,10);
await measure('portable.export-import.typical',async()=>{const fixture=libraryFixture();const source=await fixture.library.exportReviewData(repository,stash);const target=libraryFixture();await target.library.importReviewData(source);assert.equal(target.counts.diff,0);},100);
const nearLimit=api.parsePortableReview(portable), padding='x'.repeat(Math.floor(api.MAX_PACKAGE_BYTES*.9/3));
for(const layer of ['all','staged','unstaged'])nearLimit.layers[layer].files[0].newContent+='\n'+padding;
const large=JSON.stringify(nearLimit);assert.ok(Buffer.byteLength(large)<api.MAX_PACKAGE_BYTES);
await measure('portable.parse.near-limit',()=>{const parsed=api.parsePortableReview(large);assert.equal(parsed.layers.all.files[0].newContent.length,nearLimit.layers.all.files[0].newContent.length);},1000);
report.metrics.at(-1).packageBytes=Buffer.byteLength(large);
global.gc?.();report.memory.push({name:'node.after-compute-gc',heapMiB:+(process.memoryUsage().heapUsed/1024**2).toFixed(2)});

const browserSource=await bundle({stdin:{resolveDir:root,loader:'tsx',contents:`
import {createRoot} from 'react-dom/client';
import {ReviewApp} from './src/ui/ReviewApp';
import {BenchmarkHost} from './scripts/benchmark-fixtures';
import {renderPreviewMarkdown} from './src/ui/MarkdownText';
const scenario=new URLSearchParams(location.search).get('scenario')||'typical';
const embedded=new URLSearchParams(location.search).get('embed')==='1';
const host=new BenchmarkHost(scenario), root=createRoot(document.getElementById('root'));
host.listArchivedReviews=async()=>Array.from({length:120},(_,index)=>({...host.stashes[0],hash:(index+10001).toString(16).padStart(40,'0'),ref:'Archived',message:'Archived idea '+index,archived:true,inStashList:false}));
host.renderMarkdown=renderPreviewMarkdown;
const longTasks=[];new PerformanceObserver(list=>list.getEntries().forEach(entry=>longTasks.push({start:entry.startTime,duration:entry.duration}))).observe({type:'longtask',buffered:true});
let generation=0;
function mount(){root.render(<ReviewApp key={++generation} host={host} embedded={embedded} target={embedded?{repositoryId:host.repository.id,stashHash:host.stashes[0].hash,file:host.files[0].path}:undefined}/>);}
mount();window.durableBenchmark={host,longTasks,mount,unmount:()=>root.render(null)};
`},format:'esm',platform:'browser'});
const css=await readFile(join(root,'preview/demo.css'),'utf8')+'\n'+await readFile(join(root,'styles.css'),'utf8');
report.browserBundle={sha256:createHash('sha256').update(browserSource).digest('hex'),bytes:Buffer.byteLength(browserSource),gzipBytes:gzipSync(browserSource).length};
const html='<!doctype html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body class="theme-dark"><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
const server=createServer((request,response)=>{response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type',request.url==='/app.js'?'text/javascript':'text/html');response.end(request.url==='/app.js'?browserSource:html);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port, browser=await chromium.launch();report.environment.chromium=browser.version();
try {
  for(const scenario of ['typical','many-files']) {
    const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}), page=await context.newPage(), cdp=await context.newCDPSession(page);
    page.on('pageerror',error=>report.browserErrors.push({scenario,message:error.message}));
    const initial=[];
    for(let sample=0;sample<samples;sample++){await page.goto(url+'/?scenario='+scenario);await page.locator('.sr-code').first().waitFor();initial.push(await page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return performance.now();}));}
    await record(`ui.${scenario}.initial-paint`,initial,scenario==='typical'?500:2000);
    const act=async(label,inputValue)=>page.evaluate(async({label,inputValue})=>{
      const app=document.querySelector('.sr-app'), before=window.durableBenchmark.host.counts.diff, start=performance.now();
      if(inputValue!==undefined){const element=app.querySelector('input[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,inputValue);element.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,110));}
      else {const element=[...app.querySelectorAll('button,input[type="checkbox"]')].find(element=>element.getAttribute('aria-label')===label||element.textContent.trim()===label);if(!element||element.disabled)throw new Error('Missing control '+label);element.click();}
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {elapsed:performance.now()-start,diffReads:window.durableBenchmark.host.counts.diff-before};
    },{label,inputValue});
    const search=[], totalSearch=[], noise=[], layer=[];
    for(let sample=0;sample<samples;sample++) {
      const result=await act('Find in changes',sample%2?'after':'before');assert.equal(result.diffReads,0);totalSearch.push(result.elapsed);search.push(Math.max(0,result.elapsed-100));
      const whitespace=await act('Ignore whitespace changes');assert.equal(whitespace.diffReads,0);noise.push(whitespace.elapsed);
      layer.push((await act(sample%2?'All changes':'Staged')).elapsed);
    }
    await record(`ui.${scenario}.search-total`,totalSearch,210,{deliberateDebounceMs:100,measurementWaitMs:110});
    await record(`ui.${scenario}.search-excluding-debounce`,search,100,{excludedDebounceMs:100,measurementWaitMs:110});
    await record(`ui.${scenario}.noise-toggle`,noise,100);await record(`ui.${scenario}.layer-switch`,layer,100);
    if(scenario==='typical') {
      const screenshots=join(root,'benchmarks/screenshots');await mkdir(screenshots,{recursive:true});
      await page.screenshot({path:join(screenshots,'durable-desktop.png')});
      await page.setViewportSize({width:1024,height:640});await page.screenshot({path:join(screenshots,'durable-laptop.png')});await page.setViewportSize({width:1440,height:900});
      const embedPage=await context.newPage();await embedPage.goto(url+'/?embed=1');await embedPage.locator('.sr-code').first().waitFor();await embedPage.screenshot({path:join(screenshots,'durable-embed.png')});await embedPage.close();
    }
    await act('Archived reviews');await page.locator('.sr-stash-card').first().waitFor();assert.equal(await page.locator('.sr-stash-card').count(),50);
    const paging=[];
    for(let sample=0;sample<samples;sample++){const next=sample%2?'Previous archive page':'Next archive page';const result=await act(next);assert.equal(result.diffReads,0);paging.push(result.elapsed);}
    await record(`ui.${scenario}.archive-paging`,paging,100);report.assertions.push(`${scenario}: search, whitespace and archive paging issue no diff reads; archive pages render 50 entries.`);
    await cdp.send('HeapProfiler.collectGarbage');const baseline=(await cdp.send('Runtime.getHeapUsage')).usedSize;
    for(let cycle=0;cycle<5;cycle++) {await page.evaluate(()=>window.durableBenchmark.unmount());await page.waitForFunction(()=>!document.querySelector('.sr-app'));await page.evaluate(()=>window.durableBenchmark.mount());await page.locator('.sr-code').first().waitFor();}
    await page.evaluate(()=>window.durableBenchmark.unmount());await page.waitForFunction(()=>!document.querySelector('.sr-app'));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await cdp.send('HeapProfiler.collectGarbage');
    const after=(await cdp.send('Runtime.getHeapUsage')).usedSize;report.memory.push({name:`browser.${scenario}.five-mount-unmount-gc`,mountedHeapMiB:+(baseline/1024**2).toFixed(2),unmountedHeapMiB:+(after/1024**2).toFixed(2),deltaMiB:+((after-baseline)/1024**2).toFixed(2)});
    report.metrics.push({name:`ui.${scenario}.long-tasks`,count:await page.evaluate(()=>window.durableBenchmark.longTasks.length),totalDurationMs:await page.evaluate(()=>window.durableBenchmark.longTasks.reduce((sum,entry)=>sum+entry.duration,0))});
    await context.close();await checkpoint();
  }
  assert.deepEqual(report.browserErrors,[]);report.assertions.push('Production browser completed without uncaught errors.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await checkpoint();}
process.stdout.write(`Saved ${report.metrics.length} metrics to ${output}\n`);
