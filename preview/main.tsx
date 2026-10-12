import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewApp } from '../src/ui/ReviewApp';
import { DemoHost } from './demo-host';
import {parseReviewParameters} from '../src/markdown';
import type {ReviewTarget} from '../src/types';
import './demo.css';
import '../styles.css';

const host = new DemoHost();
window.__demoHost = host;
const query = new URLSearchParams(location.search);
const target = query.has('repo') || query.has('stash') ? parseReviewParameters(Object.fromEntries(query)) : undefined;
const embedded = ['1', '2'].includes(query.get('embed') ?? '');
const embedCount = query.get('embed') === '2' ? 2 : 1;

function DemoApp() {
  const [reviewTarget, setReviewTarget] = useState(target);
  const [inNote, setInNote] = useState(embedded);
  const [notice, setNotice] = useState('');
  const [light, setLight] = useState(new URLSearchParams(location.search).get('theme') === 'light');
  useEffect(() => {
    document.body.className = light ? 'theme-light' : 'theme-dark';
  }, [light]);
  useEffect(() => {
    const listener = (event: Event) => {setReviewTarget((event as CustomEvent<ReviewTarget>).detail); setInNote(false);};
    window.addEventListener('demo-open-review', listener);
    return () => window.removeEventListener('demo-open-review', listener);
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const listener = (event: Event) => {
      setNotice((event as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setNotice(''), 6000);
    };
    window.addEventListener('demo-notice', listener);
    return () => { window.removeEventListener('demo-notice', listener); clearTimeout(timer); };
  }, []);
  return <div className="demo-shell">
    <div className="demo-banner">
      <span><strong>Demo vault</strong><span className="demo-explanation"> · Fictional repository. Your files are never accessed.</span></span>
      <button type="button" onClick={() => setLight(value => !value)} aria-label={light ? 'Switch to dark theme' : 'Switch to light theme'}>{light ? 'Dark theme' : 'Light theme'}</button>
    </div>
    <div className="demo-content">{inNote ? <article style={{maxWidth: 860, margin: '0 auto', padding: 20}}><h2>Project notes</h2><p>A live review of the saved work, embedded in a Markdown note.</p>{Array.from({length: embedCount}, (_, index) => <div className="stash-review-embed" key={index}><ReviewApp host={host} target={reviewTarget} embedded/></div>)}</article> : <ReviewApp host={host} target={reviewTarget}/>}</div>
    {notice && <div role="status" className="demo-notice">{notice}</div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<DemoApp />);
