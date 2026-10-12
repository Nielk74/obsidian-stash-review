import {createRoot} from 'react-dom/client';
import {ReviewApp} from '../src/ui/ReviewApp';
import {BenchmarkHost, workloads} from './benchmark-fixtures';

const query = new URLSearchParams(location.search);
const scenario = (query.get('scenario') ?? 'typical') as keyof typeof workloads;
const host = new BenchmarkHost(scenario);
const root = createRoot(document.getElementById('root')!);
const longTasks: Array<{start: number; duration: number}> = [];
new PerformanceObserver(list => {
  for (const entry of list.getEntries()) longTasks.push({start: entry.startTime, duration: entry.duration});
}).observe({type: 'longtask', buffered: true});
let generation = 0;
const startedAt = performance.now();
function mount(count = scenario === 'multi-embed' ? 6 : 1) {
  generation++;
  if (count === 1) root.render(<ReviewApp key={generation} host={host}/>);
  else root.render(<main style={{maxWidth: 1000, margin: '0 auto'}}>{Array.from({length: count}, (_, index) => <div className="stash-review-embed" key={generation + '-' + index}><ReviewApp host={host} embedded target={{repositoryId: host.repository.id, stashHash: host.stashes[0].hash, file: host.files[0].path}}/></div>)}</main>);
}
async function paint() {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const app = document.querySelector('.sr-app');
  if (!app) return;
  for (let frame = 0; frame < 120; frame++) {
    const pending = [...app.querySelectorAll('.sr-deferred-placeholder')].some(element => {
      const root = element.closest('.sr-diff-scroll, .sr-annotations-panel, .sr-stash-list, .sr-tree-items');
      if (!root) return false;
      const viewport = root.getBoundingClientRect();
      if (viewport.right <= 0 || viewport.left >= innerWidth || viewport.bottom <= 0 || viewport.top >= innerHeight) return false;
      const article = element.closest('.sr-diff-file');
      if (article) {
        const bounds = article.getBoundingClientRect();
        if (bounds.bottom < viewport.top || bounds.top > viewport.bottom) return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && viewport.height > 0 && rect.bottom >= viewport.top && rect.top <= viewport.bottom;
    });
    if (!pending) return;
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  throw new Error('Visible deferred content did not finish mounting');
}
mount();
declare global {
  interface Window {
    benchmark: {host: BenchmarkHost; longTasks: typeof longTasks; startedAt: number; mount: typeof mount; paint: typeof paint; unmount: () => void};
  }
}
window.benchmark = {host, longTasks, startedAt, mount, paint, unmount: () => root.render(null)};
