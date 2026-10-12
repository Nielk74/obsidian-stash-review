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
mount();
declare global {
  interface Window {
    benchmark: {host: BenchmarkHost; longTasks: typeof longTasks; startedAt: number; mount: typeof mount; unmount: () => void};
  }
}
window.benchmark = {host, longTasks, startedAt, mount, unmount: () => root.render(null)};
