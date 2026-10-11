import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewApp } from '../src/ui/ReviewApp';
import { DemoHost } from './demo-host';
import './demo.css';
import '../styles.css';

const host = new DemoHost();
window.__demoHost = host;

function DemoApp() {
  const [notice, setNotice] = useState('');
  const [light, setLight] = useState(new URLSearchParams(location.search).get('theme') === 'light');
  useEffect(() => {
    document.body.className = light ? 'theme-light' : 'theme-dark';
  }, [light]);
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
    <div className="demo-content"><ReviewApp host={host} /></div>
    {notice && <div role="status" className="demo-notice">{notice}</div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<DemoApp />);
