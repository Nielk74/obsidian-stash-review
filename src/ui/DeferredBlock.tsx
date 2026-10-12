import {useEffect, useRef, useState, type ReactNode} from 'react';

interface Watcher {observer: IntersectionObserver; callbacks: Map<Element, () => void>}
const watchers = new WeakMap<Element, Watcher>();

/** Mount near the viewport once, then retain the content and any in-progress edits. */
export function DeferredBlock({height, force = false, render}: {height: number; force?: boolean; render: () => ReactNode}) {
  const element = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(force);
  useEffect(() => {
    if (ready) return;
    if (force) {setReady(true); return;}
    const target = element.current;
    const root = target?.closest('.sr-diff-scroll, .sr-annotations-panel, .sr-stash-list');
    if (!target || !root || typeof IntersectionObserver === 'undefined') {setReady(true); return;}
    let watcher = watchers.get(root);
    if (!watcher) {
      const callbacks = new Map<Element, () => void>();
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) callbacks.get(entry.target)?.();
      }, {root, rootMargin: '600px 0px'});
      watcher = {observer, callbacks}; watchers.set(root, watcher);
    }
    const active = watcher;
    active.callbacks.set(target, () => setReady(true)); active.observer.observe(target);
    return () => {
      active.observer.unobserve(target); active.callbacks.delete(target);
      if (!active.callbacks.size) {active.observer.disconnect(); watchers.delete(root);}
    };
  }, [ready, force]);
  return <div ref={element} className="sr-deferred-block">{ready || force ? render() : <div aria-hidden="true" style={{height}}/>}</div>;
}
