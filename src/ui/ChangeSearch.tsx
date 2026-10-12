import {ChevronLeft, ChevronRight, Search, X} from 'lucide-react';

export function ChangeSearch({query,onQuery,count,active,onPrevious,onNext,blocked=false}: {
  query: string; onQuery: (query: string) => void; count: number; active: number;
  onPrevious: () => void; onNext: () => void; blocked?: boolean;
}) {
  return <div className="sr-change-search"><Search size={14}/>
    <input type="search" aria-label="Find in changes" title="Search saved diff text" placeholder="Find in diff…" value={query}
      onChange={event => onQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') {event.preventDefault(); if (!blocked && count) (event.shiftKey ? onPrevious : onNext)();}
        if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); onQuery('');}
      }}/>
    <span className="sr-search-count sr-change-search-count" aria-live="polite">{query ? count ? `${Math.max(1,active + 1)}/${count}` : '0 matches' : 'Diff text'}</span>
    {query && <><button type="button" className="sr-icon-button" aria-label="Previous change match" onClick={onPrevious} disabled={!count || blocked}><ChevronLeft size={14}/></button>
      <button type="button" className="sr-icon-button" aria-label="Next change match" onClick={onNext} disabled={!count || blocked}><ChevronRight size={14}/></button>
      <button type="button" className="sr-icon-button" aria-label="Clear change search" onClick={() => onQuery('')}><X size={13}/></button></>}
  </div>;
}
